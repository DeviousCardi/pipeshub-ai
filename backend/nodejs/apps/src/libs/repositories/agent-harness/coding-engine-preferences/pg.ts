import { HarnessNotFoundError } from '../../../../modules/agent-harness/domain/errors';
import type {
  CodingEnginePreferences,
  StoredCodingEngines,
} from '../../../../modules/agent-harness/ports/coding-engines';
import type { SessionRepository } from '../../../../modules/agent-harness/domain/repository';
import { getConversationRepository } from '../../conversation';
import { getOrgRepository } from '../../org';
import { getUserRepository } from '../../user';
import { inBoundOrgUnit } from '../pg-documents/ambient';
import { orgOrJobsUnit } from '../pg-documents/org-or-jobs';
import { decodeDoc, docParam, rowRegion } from '../pg-documents/pg';

const ORG = 'org';
const userSubject = (userId: string): string => `user:${userId}`;
const sessionSubject = (sessionId: string): string => `session:${sessionId}`;
const REASON = 'coding-engine choices';

type Choices = Partial<{
  codingEngine: string;
  defaultCodingEngine: string;
  codingEngineAutoRoute: boolean;
  codingEnginePin: string;
  repository: SessionRepository;
}>;

const stringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/**
 * The coding-engine choices (ENGPICK) on PostgreSQL: the harness's own rows in `harness.coding_engine_choices`, one
 * for the org, one per person and one per conversation. Main's user, org and conversation rows are not widened for
 * them; whether the person, the org or the conversation is live is their repositories' answer, so a choice of a
 * removed person or conversation reads as none and is never written, as on MongoDB.
 */
export class PgCodingEnginePreferences implements CodingEnginePreferences {
  async read(orgId: string, userId: string): Promise<StoredCodingEngines> {
    const [user, org, mine, ours] = await Promise.all([
      inBoundOrgUnit(orgId, () => getUserRepository().getLive(orgId, userId)),
      inBoundOrgUnit(orgId, () => getOrgRepository().getLive(orgId)),
      this.choices(orgId, userSubject(userId)),
      this.choices(orgId, ORG),
    ]);
    const orgChoices = org === null ? {} : ours;
    return {
      user: user === null ? null : stringOrNull(mine.codingEngine),
      org: stringOrNull(orgChoices.defaultCodingEngine),
      orgAutoRoute: orgChoices.codingEngineAutoRoute !== false,
    };
  }

  /** Stored only when off, so an org that never chose reads the default (on). */
  async writeOrgAutoRoute(orgId: string, on: boolean): Promise<void> {
    await this.liveOrg(orgId);
    await this.set(
      orgId,
      ORG,
      'codingEngineAutoRoute',
      on ? null : { codingEngineAutoRoute: false },
    );
  }

  async writeUser(
    orgId: string,
    userId: string,
    choice: string | null,
  ): Promise<void> {
    if (
      (await inBoundOrgUnit(orgId, () =>
        getUserRepository().getLive(orgId, userId),
      )) === null
    )
      throw new HarnessNotFoundError('User not found');
    await this.set(
      orgId,
      userSubject(userId),
      'codingEngine',
      choice === null ? null : { codingEngine: choice },
    );
  }

  async writeOrg(orgId: string, engine: string | null): Promise<void> {
    await this.liveOrg(orgId);
    await this.set(
      orgId,
      ORG,
      'defaultCodingEngine',
      engine === null ? null : { defaultCodingEngine: engine },
    );
  }

  async readSession(orgId: string, sessionId: string): Promise<string | null> {
    return stringOrNull(
      (await this.sessionChoices(orgId, sessionId)).codingEngine,
    );
  }

  async writeSession(
    orgId: string,
    sessionId: string,
    choice: string | null,
  ): Promise<void> {
    await this.writeSessionField(
      orgId,
      sessionId,
      'codingEngine',
      choice === null ? null : { codingEngine: choice },
    );
  }

  async readSessionPin(
    orgId: string,
    sessionId: string,
  ): Promise<string | null> {
    return stringOrNull(
      (await this.sessionChoices(orgId, sessionId)).codingEnginePin,
    );
  }

  async writeSessionPin(
    orgId: string,
    sessionId: string,
    engine: string | null,
  ): Promise<void> {
    await this.writeSessionField(
      orgId,
      sessionId,
      'codingEnginePin',
      engine === null ? null : { codingEnginePin: engine },
    );
  }

  async readSessionRepository(
    orgId: string,
    sessionId: string,
  ): Promise<SessionRepository | null> {
    const stored = (await this.sessionChoices(orgId, sessionId)).repository;
    if (
      typeof stored?.url !== 'string' ||
      typeof stored.toolsetInstanceId !== 'string'
    ) {
      return null;
    }
    return {
      url: stored.url,
      toolsetInstanceId: stored.toolsetInstanceId,
      ...(typeof stored.baseRef === 'string'
        ? { baseRef: stored.baseRef }
        : {}),
    };
  }

  async writeSessionRepository(
    orgId: string,
    sessionId: string,
    repository: SessionRepository | null,
  ): Promise<void> {
    await this.writeSessionField(
      orgId,
      sessionId,
      'repository',
      repository === null
        ? null
        : {
            repository: {
              url: repository.url,
              toolsetInstanceId: repository.toolsetInstanceId,
              ...(repository.baseRef !== undefined
                ? { baseRef: repository.baseRef }
                : {}),
            },
          },
    );
  }

  /** Whether or not the person is still live: their erasure runs after the soft delete. */
  eraseUser(orgId: string, userId: string): Promise<number> {
    return this.erase(orgId, userSubject(userId));
  }

  /** Whether or not the conversation is still live: its erasure runs after the soft delete. */
  eraseSession(orgId: string, sessionId: string): Promise<number> {
    return this.erase(orgId, sessionSubject(sessionId));
  }

  private erase(orgId: string, subject: string): Promise<number> {
    return orgOrJobsUnit(
      undefined,
      orgId,
      REASON,
      { write: true },
      async (k) => {
        const { rowCount } = await k.query(
          `/* pipeshub:harness.coding_engine_choices_erase */ DELETE FROM harness.coding_engine_choices
            WHERE org_id = $1 AND subject = $2`,
          [orgId, subject],
        );
        return rowCount ?? 0;
      },
    );
  }

  private async liveOrg(orgId: string): Promise<void> {
    if (
      (await inBoundOrgUnit(orgId, () =>
        getOrgRepository().getLive(orgId),
      )) === null
    )
      throw new HarnessNotFoundError('Organization not found');
  }

  private async liveSession(
    orgId: string,
    sessionId: string,
  ): Promise<boolean> {
    const session = await inBoundOrgUnit(orgId, () =>
      getConversationRepository().findById(sessionId),
    );
    return (
      session !== null && session.orgId === orgId && session.isDeleted !== true
    );
  }

  private async sessionChoices(
    orgId: string,
    sessionId: string,
  ): Promise<Choices> {
    const [live, choices] = await Promise.all([
      this.liveSession(orgId, sessionId),
      this.choices(orgId, sessionSubject(sessionId)),
    ]);
    return live ? choices : {};
  }

  private async writeSessionField(
    orgId: string,
    sessionId: string,
    field: keyof Choices,
    value: Choices | null,
  ): Promise<void> {
    if (!(await this.liveSession(orgId, sessionId)))
      throw new HarnessNotFoundError('Conversation not found');
    await this.set(orgId, sessionSubject(sessionId), field, value);
  }

  private choices(orgId: string, subject: string): Promise<Choices> {
    return orgOrJobsUnit(
      undefined,
      orgId,
      REASON,
      { write: false },
      async (k) => {
        const { rows } = await k.query<{ doc: unknown }>(
          `/* pipeshub:harness.coding_engine_choices_get */ SELECT doc FROM harness.coding_engine_choices
            WHERE org_id = $1 AND subject = $2`,
          [orgId, subject],
        );
        return rows[0] === undefined ? {} : decodeDoc<Choices>(rows[0].doc);
      },
    );
  }

  /** Sets `field` to what `value` holds, or removes it when `value` is null; the other choices of the row stay. */
  private async set(
    orgId: string,
    subject: string,
    field: keyof Choices,
    value: Choices | null,
  ): Promise<void> {
    await orgOrJobsUnit(undefined, orgId, REASON, { write: true }, (k) =>
      k.query(
        `/* pipeshub:harness.coding_engine_choices_set */ INSERT INTO harness.coding_engine_choices AS c
           (org_id, subject, doc, region)
         VALUES ($1, $2, $4::jsonb, $5)
         ON CONFLICT (org_id, subject) DO UPDATE SET doc = (c.doc - $3::text) || EXCLUDED.doc`,
        [orgId, subject, field, docParam(value ?? {}), rowRegion()],
      ),
    );
  }
}
