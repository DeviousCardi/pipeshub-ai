import { ControlPlaneTransaction } from '../../control-plane';
import {
  AdminWebhookSettingsError,
  type AuthHeader,
  checkedHeader,
  checkedUrl,
} from '../domain/admin-webhooks';
import {
  LegacySecurityDocument,
  LegacySecurityEntry,
  POLICY_WEBHOOK_TIMEOUT_DEFAULT_MS,
  POLICY_WEBHOOK_TIMEOUT_MAX_MS,
  POLICY_WEBHOOK_TIMEOUT_MIN_MS,
  PolicyWebhookDocument,
  PolicyWebhookEntry,
  PolicyWebhookSettings,
  PolicyWebhookView,
  policyWebhookViewOf,
} from '../domain/policy-webhook';
import { ConfigDocumentStore } from '../ports/config-document-store';
import { auditedConfigUpdate, updateConfigDocument } from './config-documents';

export interface PolicyWebhookUpdate {
  readonly enabled: boolean;
  readonly url: string;
  readonly timeoutMs?: number;
  /** Absent: keep the stored header; null: remove it. */
  readonly authHeader?: AuthHeader | null;
}

export interface PolicyWebhookSettingsUpdate {
  /** Absent: unchanged; null: removed. */
  readonly policyWebhook?: PolicyWebhookUpdate | null;
}

const BOOKKEEPING = new Set(['policyWebhook', 'updatedAt', 'updatedBy']);

/** An old-document entry that still holds a setting besides the webhook. */
const holdsOtherSettings = (entry: LegacySecurityEntry): boolean =>
  Object.entries(entry).some(
    ([key, value]) =>
      !BOOKKEEPING.has(key) && value !== null && value !== undefined,
  );

const withoutOrg = <T>(
  orgs: Readonly<Record<string, T>>,
  orgId: string,
): Record<string, T> =>
  Object.fromEntries(Object.entries(orgs).filter(([id]) => id !== orgId));

/** The old document's webhooks, as entries of the new one. */
function webhooksToCarry(
  legacy: LegacySecurityDocument | null,
): Record<string, PolicyWebhookEntry> {
  const orgs: Record<string, PolicyWebhookEntry> = {};
  for (const [orgId, entry] of Object.entries(legacy?.orgs ?? {})) {
    if (entry.policyWebhook === null) continue;
    orgs[orgId] = {
      policyWebhook: entry.policyWebhook,
      updatedAt: entry.updatedAt,
      updatedBy: entry.updatedBy,
    };
  }
  return orgs;
}

/**
 * Moves each org's webhook out of the document it shared with other settings
 * into its own, the one the worker reads. Run at every start and before the
 * first save; it writes only when something is left to move. A copy in the
 * old document is copied again only when it was saved after the move (a
 * replica of the previous release saving during an upgrade), so a webhook
 * removed since the move stays removed; every copy then leaves the old
 * document, whose other settings stay as they are. A fresh install gets an
 * empty document, which tells the worker not to look in the old one. Answers
 * how many webhooks it copied. Until it runs, the first save carries the old
 * document's webhooks over in its own audited write instead.
 */
export async function movePolicyWebhooks(
  target: ConfigDocumentStore<PolicyWebhookDocument>,
  legacy: ConfigDocumentStore<LegacySecurityDocument>,
  now: () => number = Date.now,
): Promise<number> {
  const left = (await legacy.read()).value?.orgs ?? {};
  const waiting = Object.entries(left).filter(
    ([, entry]) => entry.policyWebhook !== null,
  );
  let copied = 0;
  if (waiting.length > 0 || (await target.read()).value === null) {
    await updateConfigDocument(target, (current) => {
      const carried = webhooksToCarry({ orgs: left });
      if (current === null) {
        copied = Object.keys(carried).length;
        return { orgs: carried, movedAt: now() };
      }
      const orgs: Record<string, PolicyWebhookEntry> = { ...current.orgs };
      copied = 0;
      for (const [orgId, entry] of Object.entries(carried)) {
        const saved = orgs[orgId];
        if (entry.updatedAt <= current.movedAt) continue;
        if (saved !== undefined && saved.updatedAt >= entry.updatedAt) continue;
        orgs[orgId] = entry;
        copied += 1;
      }
      return copied === 0 ? null : { ...current, orgs };
    });
  }
  if (waiting.length > 0) {
    await updateConfigDocument(legacy, (current) => {
      if (current === null) return null;
      const orgs: Record<string, LegacySecurityEntry> = {};
      let changed = false;
      for (const [orgId, entry] of Object.entries(current.orgs)) {
        if (entry.policyWebhook === null) {
          orgs[orgId] = entry;
          continue;
        }
        changed = true;
        const rest: LegacySecurityEntry = { ...entry, policyWebhook: null };
        if (holdsOtherSettings(rest)) orgs[orgId] = rest;
      }
      return changed ? { orgs } : null;
    });
  }
  return copied;
}

/**
 * Org erasure (G-40): the org's webhook leaves its document, and the org's
 * entry leaves the old shared document too, header values with them. Not
 * audited: the org's own chain is erased with it.
 */
export async function eraseOrgPolicyWebhook(
  target: ConfigDocumentStore<PolicyWebhookDocument>,
  legacy: ConfigDocumentStore<LegacySecurityDocument>,
  orgId: string,
): Promise<void> {
  if ((await target.read()).value?.orgs[orgId] !== undefined) {
    await updateConfigDocument(target, (current) =>
      current?.orgs[orgId] === undefined
        ? null
        : { ...current, orgs: withoutOrg(current.orgs, orgId) },
    );
  }
  if ((await legacy.read()).value?.orgs[orgId] !== undefined) {
    await updateConfigDocument(legacy, (current) =>
      current?.orgs[orgId] === undefined
        ? null
        : { orgs: withoutOrg(current.orgs, orgId) },
    );
  }
}

/**
 * Each org's external policy webhook (G-40), one KV document encrypted with
 * the configuration secret (so the Python worker reads it through
 * ConfigurationService), changed under compare-and-set in an audited
 * control-plane transaction. The audit chain records what changed, never a
 * header's value. Until the webhooks moved (`movePolicyWebhooks`), a read
 * answers from the old document, as the worker does.
 */
export class ConfigPolicyWebhookSettings {
  constructor(
    private readonly store: ConfigDocumentStore<PolicyWebhookDocument>,
    private readonly legacy: ConfigDocumentStore<LegacySecurityDocument>,
    private readonly transaction: ControlPlaneTransaction | null,
    private readonly now: () => number = Date.now,
  ) {}

  /** Moves the webhooks out of the old shared document, if any are left there (`movePolicyWebhooks`). */
  moveFromSharedDocument(): Promise<number> {
    return movePolicyWebhooks(this.store, this.legacy, this.now);
  }

  async view(orgId: string): Promise<PolicyWebhookView> {
    const document = (await this.store.read()).value;
    if (document !== null) {
      return policyWebhookViewOf(document.orgs[orgId]?.policyWebhook);
    }
    return policyWebhookViewOf(
      (await this.legacy.read()).value?.orgs[orgId]?.policyWebhook,
    );
  }

  private checked(
    update: PolicyWebhookUpdate | null | undefined,
    stored: PolicyWebhookSettings | null,
  ): PolicyWebhookSettings | null {
    if (update === undefined) return stored;
    if (update === null) return null;
    const timeoutMs =
      update.timeoutMs ??
      stored?.timeoutMs ??
      POLICY_WEBHOOK_TIMEOUT_DEFAULT_MS;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < POLICY_WEBHOOK_TIMEOUT_MIN_MS ||
      timeoutMs > POLICY_WEBHOOK_TIMEOUT_MAX_MS
    ) {
      throw new AdminWebhookSettingsError(
        `The timeout is ${String(POLICY_WEBHOOK_TIMEOUT_MIN_MS)} to ${String(POLICY_WEBHOOK_TIMEOUT_MAX_MS)} ms`,
      );
    }
    return {
      enabled: update.enabled,
      url: checkedUrl(update.url),
      timeoutMs,
      authHeader: checkedHeader(update.authHeader, stored?.authHeader ?? null),
    };
  }

  async write(
    orgId: string,
    update: PolicyWebhookSettingsUpdate,
    by: string,
  ): Promise<PolicyWebhookView> {
    if (this.transaction === null) {
      throw new Error('Policy webhook settings are read-only here');
    }
    // Before the move, the first save carries every org's webhook over, inside its own audited write.
    const carried =
      (await this.store.read()).value === null
        ? webhooksToCarry((await this.legacy.read()).value)
        : {};
    const stored =
      (await this.store.read()).value?.orgs[orgId] ?? carried[orgId];
    const policyWebhook = this.checked(
      update.policyWebhook,
      stored?.policyWebhook ?? null,
    );
    const at = this.now();
    await auditedConfigUpdate(
      this.transaction,
      this.store,
      {
        orgId,
        by,
        object: { type: 'policy-section', id: 'policyWebhook' },
        // What the chain records: the view, which never holds a header's value.
        section: (document) => {
          const entry = document?.orgs[orgId];
          return entry === undefined
            ? null
            : policyWebhookViewOf(entry.policyWebhook);
        },
      },
      (current) => {
        const orgs = withoutOrg(current?.orgs ?? carried, orgId);
        if (policyWebhook !== null) {
          orgs[orgId] = { policyWebhook, updatedAt: at, updatedBy: by };
        }
        return { orgs, movedAt: current?.movedAt ?? at };
      },
    );
    return this.view(orgId);
  }
}
