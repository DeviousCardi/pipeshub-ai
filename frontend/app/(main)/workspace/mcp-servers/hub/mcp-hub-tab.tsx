'use client';

import React, { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Box, Button, Checkbox, Code, Flex, Text, TextField } from '@radix-ui/themes';
import { LoadingButton } from '@/app/components/ui/loading-button';
import { MaterialIcon } from '@/app/components/ui/MaterialIcon';
import { LoadState } from '../../ai-accounts/components/load-state';
import { formatDateTime } from '../../harness-ui/format';
import { isHarnessError, refusalText, toHarnessError, type HarnessError } from '../../harness-ui/refusal';
import { McpHubApi, MCP_HUB_REFUSALS, toolReasonKey, type Manifest, type ManifestTool, type RunnerSettings } from './api';
import type { ManifestLoad } from './use-manifest';

const STATUS_COLOR = { approved: 'green', changed: 'amber', unapproved: 'gray', refused: 'red', unknown: 'gray' } as const;

const schemaText = (schema: unknown): string => {
  try {
    return JSON.stringify(schema ?? {}, null, 2);
  } catch {
    return String(schema);
  }
};

/** Approved-and-unchanged tools stay approved unless the admin unticks them. */
export const initialSelection = (manifest: Manifest): Set<string> =>
  new Set(manifest.tools.filter((tool) => tool.status === 'approved' && tool.digest !== null).map((tool) => tool.name));

function Diff({ tool }: { tool: ManifestTool }) {
  const { t } = useTranslation();
  if (!tool.approved) return null;
  const descriptionChanged = tool.approved.description !== tool.description;
  const before = schemaText(tool.approved.inputSchema);
  const after = schemaText(tool.inputSchema);
  return (
    <Flex direction="column" gap="2" data-testid="manifest-diff" style={{ paddingLeft: 'var(--space-5)' }}>
      {tool.changes.length > 0 && (
        <Flex direction="column" gap="1" data-testid="manifest-changes">
          <Text size="1" weight="medium">
            {t('mcpHub.diff.changesTitle')}
          </Text>
          {tool.changes.map((change, index) => (
            <Text key={`${change.change}:${change.name ?? ''}:${index}`} size="1" style={{ color: 'var(--amber-11)' }}>
              • {t(`mcpHub.diff.change.${change.change}`, { name: change.name ?? '' })}
            </Text>
          ))}
        </Flex>
      )}
      {descriptionChanged && (
        <>
          <Text size="1" weight="medium">
            {t('mcpHub.diff.description')}
          </Text>
          <Text size="1" style={{ color: 'var(--red-11)', textDecoration: 'line-through' }}>
            {t('mcpHub.diff.approved')}: {tool.approved.description}
          </Text>
          <Text size="1" style={{ color: 'var(--green-11)' }}>
            {t('mcpHub.diff.current')}: {tool.description}
          </Text>
        </>
      )}
      {before !== after && (
        <>
          <Text size="1" weight="medium">
            {t('mcpHub.diff.schema')}
          </Text>
          <Flex gap="2" wrap="wrap">
            <Box style={{ flex: 1, minWidth: 200 }}>
              <Text size="1">{t('mcpHub.diff.approved')}</Text>
              <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: 0 }}>{before}</pre>
            </Box>
            <Box style={{ flex: 1, minWidth: 200 }}>
              <Text size="1">{t('mcpHub.diff.current')}</Text>
              <pre style={{ fontSize: 11, whiteSpace: 'pre-wrap', margin: 0 }}>{after}</pre>
            </Box>
          </Flex>
        </>
      )}
    </Flex>
  );
}

/**
 * The scanner's findings on one tool (MX-04), in plain words with the passage
 * that triggered each, and the admin's confirmation that they read them.
 */
function ToolWarnings({
  tool,
  acknowledged,
  onAcknowledge,
}: {
  tool: ManifestTool;
  acknowledged: boolean;
  onAcknowledge: (on: boolean) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  // Expanded while the tool still needs a decision; an approved tool's warnings were read when it was approved.
  const [open, setOpen] = useState(tool.status !== 'approved');
  const selectable = tool.digest !== null && tool.status !== 'refused';
  return (
    <Box
      data-testid="manifest-warnings"
      style={{
        marginLeft: 'var(--space-5)',
        border: '1px solid var(--amber-6)',
        background: 'var(--amber-2)',
        borderRadius: 'var(--radius-2)',
        padding: 'var(--space-2) var(--space-3)',
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        onClick={() => setOpen((prev) => !prev)}
        style={{
          all: 'unset',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-1)',
          minHeight: 32,
          width: '100%',
          color: 'var(--amber-11)',
        }}
      >
        <MaterialIcon name="warning" size={16} color="var(--amber-11)" />
        <Text size="2" weight="medium" style={{ flex: 1 }}>
          {t('mcpHub.warnings.title', { count: tool.warnings.length })}
        </Text>
        <MaterialIcon name={open ? 'expand_less' : 'expand_more'} size={18} color="var(--amber-11)" />
      </button>
      {open && (
        <Flex id={`${id}-list`} direction="column" gap="1" role="list" mt="1">
          {tool.warnings.map((warning, index) => (
            <Text key={`${warning.code}-${index}`} as="p" size="1" role="listitem" style={{ overflowWrap: 'anywhere' }}>
              {t(`mcpHub.warnings.code.${warning.code}`)}
              {warning.excerpt && (
                <>
                  {': '}
                  <Code variant="ghost" style={{ whiteSpace: 'pre-wrap' }}>
                    {warning.excerpt}
                  </Code>
                </>
              )}
            </Text>
          ))}
        </Flex>
      )}
      {selectable && (
        <Flex gap="2" align="start" mt="2">
          <Checkbox
            id={`${id}-ack`}
            checked={acknowledged}
            onCheckedChange={(value) => onAcknowledge(value === true)}
            style={{ marginTop: 2 }}
          />
          <Text as="label" htmlFor={`${id}-ack`} size="1">
            {t('mcpHub.warnings.acknowledge')}
          </Text>
        </Flex>
      )}
    </Box>
  );
}

/** Flagged tools approved as they are: their warnings were confirmed when they were approved. */
export const initialAcknowledged = (manifest: Manifest): Set<string> =>
  new Set(manifest.tools.filter((tool) => tool.status === 'approved' && tool.warnings.length > 0).map((tool) => tool.name));

function ToolRow({
  tool,
  checked,
  onToggle,
  acknowledged,
  onAcknowledge,
}: {
  tool: ManifestTool;
  checked: boolean;
  onToggle: (on: boolean) => void;
  acknowledged: boolean;
  onAcknowledge: (on: boolean) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const selectable = tool.digest !== null && tool.status !== 'refused';
  return (
    <Flex direction="column" gap="1" data-testid="manifest-tool" data-status={tool.status} data-flagged={tool.warnings.length > 0}>
      <Flex gap="2" align="center" wrap="wrap">
        <Checkbox id={id} checked={checked} disabled={!selectable} onCheckedChange={(value) => onToggle(value === true)} />
        <Text as="label" htmlFor={id} size="2" weight="medium">
          {tool.name}
        </Text>
        <Badge variant="soft" color={STATUS_COLOR[tool.status]}>
          {t(`mcpHub.status.${tool.status}`)}
        </Badge>
      </Flex>
      {tool.description && (
        <Text size="1" style={{ color: 'var(--slate-11)', paddingLeft: 'var(--space-5)' }}>
          {tool.description}
        </Text>
      )}
      {tool.status !== 'approved' && (
        <Text size="1" style={{ color: 'var(--amber-11)', paddingLeft: 'var(--space-5)' }}>
          {t(toolReasonKey(tool.reasonCode))}
        </Text>
      )}
      {tool.status === 'changed' && <Diff tool={tool} />}
      {tool.warnings.length > 0 && <ToolWarnings tool={tool} acknowledged={acknowledged} onAcknowledge={onAcknowledge} />}
    </Flex>
  );
}

function ManifestSection({
  instanceId,
  manifest,
  onReplaced,
  onReload,
}: {
  instanceId: string;
  manifest: Manifest;
  onReplaced: (manifest: Manifest) => void;
  onReload: () => void;
}) {
  const { t, i18n } = useTranslation();
  const hintId = useId();
  const [selected, setSelected] = useState<Set<string>>(() => initialSelection(manifest));
  const [acknowledged, setAcknowledged] = useState<Set<string>>(() => initialAcknowledged(manifest));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<HarnessError | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setSelected(initialSelection(manifest));
    setAcknowledged(initialAcknowledged(manifest));
  }, [manifest]);

  const picked = useMemo(
    () => manifest.tools.filter((tool) => selected.has(tool.name) && tool.digest !== null),
    [manifest, selected],
  );
  const choices = useMemo(
    () =>
      picked.map((tool) => ({
        name: tool.name,
        digest: tool.digest as string,
        acknowledgeWarnings: tool.warnings.length > 0 && acknowledged.has(tool.name),
      })),
    [picked, acknowledged],
  );
  const unconfirmed = picked.filter((tool) => tool.warnings.length > 0 && !acknowledged.has(tool.name)).map((tool) => tool.name);

  const toggle = (set: React.Dispatch<React.SetStateAction<Set<string>>>, name: string, on: boolean) =>
    set((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });

  const approve = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      onReplaced(await McpHubApi.approve(instanceId, choices));
      setSaved(true);
    } catch (failure) {
      setError(isHarnessError(failure) ? failure : toHarnessError(failure, true));
    } finally {
      setBusy(false);
    }
  };

  const stale = error?.code === 'mcp_manifest_stale';

  return (
    <Flex direction="column" gap="3" role="group" aria-label={t('mcpHub.manifestTitle')}>
      <Text size="2" weight="medium">
        {t('mcpHub.manifestTitle')}
      </Text>
      <Text size="1" style={{ color: 'var(--slate-11)' }}>
        {manifest.approved
          ? t('mcpHub.approvedBy', { by: manifest.approved.approvedBy, date: formatDateTime(manifest.approved.approvedAt, i18n.language) })
          : t('mcpHub.neverApproved')}
      </Text>
      {manifest.tools.length === 0 ? (
        <Text size="2" style={{ color: 'var(--slate-11)' }}>
          {t('mcpHub.noTools')}
        </Text>
      ) : (
        <Flex direction="column" gap="3">
          {manifest.tools.map((tool) => (
            <ToolRow
              key={tool.name}
              tool={tool}
              checked={selected.has(tool.name)}
              onToggle={(on) => toggle(setSelected, tool.name, on)}
              acknowledged={acknowledged.has(tool.name)}
              onAcknowledge={(on) => toggle(setAcknowledged, tool.name, on)}
            />
          ))}
        </Flex>
      )}
      {manifest.removed.length > 0 && (
        <Text size="1" style={{ color: 'var(--slate-11)' }}>
          {t('mcpHub.removed', { tools: manifest.removed.join(', ') })}
        </Text>
      )}
      {error && (
        <Flex direction="column" gap="2" align="start" role="alert">
          <Text size="2" style={{ color: 'var(--red-11)' }}>
            {refusalText(t, MCP_HUB_REFUSALS, error)}
          </Text>
          {stale && (
            <Button type="button" size="1" variant="soft" onClick={onReload}>
              {t('mcpHub.reload')}
            </Button>
          )}
        </Flex>
      )}
      {saved && !error && (
        <Text size="2" role="status" style={{ color: 'var(--green-11)' }}>
          {t('mcpHub.approvedNow')}
        </Text>
      )}
      <Flex direction="column" gap="2" align="start">
        <LoadingButton
          type="button"
          loading={busy}
          disabled={manifest.tools.length === 0 || unconfirmed.length > 0}
          aria-describedby={unconfirmed.length > 0 ? hintId : undefined}
          onClick={() => void approve()}
        >
          {t('mcpHub.approve', { count: choices.length })}
        </LoadingButton>
        {unconfirmed.length > 0 && (
          <Text id={hintId} size="1" style={{ color: 'var(--amber-11)' }}>
            {t('mcpHub.warnings.confirmFirst', { tools: unconfirmed.map((name) => `"${name}"`).join(', ') })}
          </Text>
        )}
      </Flex>
    </Flex>
  );
}

const hostsToText = (hosts: string[]) => hosts.join(', ');
const textToHosts = (value: string) =>
  value
    .split(/[\s,]+/)
    .map((host) => host.trim())
    .filter(Boolean);

export function RunnerSection({ instanceId }: { instanceId: string }) {
  const { t } = useTranslation();
  const id = useId();
  const [current, setCurrent] = useState<RunnerSettings | null>(null);
  const [hosts, setHosts] = useState('');
  const [image, setImage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    void McpHubApi.runner(instanceId)
      .then((settings) => {
        if (!live) return;
        setCurrent(settings);
        setHosts(hostsToText(settings.egressHosts));
        setImage(settings.runnerImage ?? '');
      })
      .catch((failure: unknown) => {
        if (live) setError(refusalText(t, MCP_HUB_REFUSALS, isHarnessError(failure) ? failure : toHarnessError(failure)));
      });
    return () => {
      live = false;
    };
  }, [instanceId, t]);

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const stored = await McpHubApi.setRunner(instanceId, {
        egressHosts: textToHosts(hosts),
        runnerImage: image.trim() === '' ? null : image.trim(),
      });
      setCurrent(stored);
      setSaved(true);
    } catch (failure) {
      setError(refusalText(t, MCP_HUB_REFUSALS, isHarnessError(failure) ? failure : toHarnessError(failure, true)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Flex direction="column" gap="3" role="group" aria-label={t('mcpHub.runner.title')}>
      <Text size="2" weight="medium">
        {t('mcpHub.runner.title')}
      </Text>
      <Text size="1" style={{ color: 'var(--slate-11)' }}>
        {t('mcpHub.runner.description')}
      </Text>
      <Flex direction="column" gap="1">
        <Text as="label" htmlFor={`${id}-hosts`} size="2" weight="medium">
          {t('mcpHub.runner.egressHosts')}
        </Text>
        <TextField.Root id={`${id}-hosts`} value={hosts} placeholder="api.example.com:443" onChange={(e) => setHosts(e.target.value)} />
        <Text size="1" style={{ color: 'var(--slate-11)' }}>
          {t('mcpHub.runner.egressHostsHint')}
        </Text>
      </Flex>
      <Flex direction="column" gap="1">
        <Text as="label" htmlFor={`${id}-image`} size="2" weight="medium">
          {t('mcpHub.runner.image')}
        </Text>
        <TextField.Root id={`${id}-image`} value={image} onChange={(e) => setImage(e.target.value)} style={{ fontFamily: 'monospace' }} />
        <Text size="1" style={{ color: 'var(--slate-11)' }}>
          {t('mcpHub.runner.imageHint')}
        </Text>
      </Flex>
      {error && (
        <Text size="2" role="alert" style={{ color: 'var(--red-11)' }}>
          {error}
        </Text>
      )}
      {saved && !error && (
        <Text size="2" role="status" style={{ color: 'var(--green-11)' }}>
          {t('mcpHub.runner.saved')}
        </Text>
      )}
      <Flex>
        <LoadingButton type="button" loading={busy} disabled={current === null} onClick={() => void save()}>
          {t('mcpHub.runner.save')}
        </LoadingButton>
      </Flex>
    </Flex>
  );
}

/** The manifest read's failure in words: its code's sentence when it has one (a 502 names which listing failed). */
function manifestUnavailableKey(manifest: ManifestLoad): string {
  const code = manifest.status === 'error' && isHarnessError(manifest.error) ? manifest.error.code : null;
  return (code !== null && MCP_HUB_REFUSALS[code]) || 'mcpHub.refusal.unavailable';
}

/**
 * An instance's hub tab: its tools against the approved manifest while the hub
 * (`MCP_HUB`) is on, and, for a STDIO server while runners
 * (`MCP_STDIO_RUNNERS`) are on, the runner it runs in.
 */
export function McpHubTab({
  instanceId,
  hub,
  runner,
  manifest,
  onReload,
  onReplaced,
}: {
  instanceId: string;
  hub: boolean;
  runner: boolean;
  manifest: ManifestLoad;
  onReload: () => void;
  onReplaced: (manifest: Manifest) => void;
}) {
  const { t } = useTranslation();
  if (!hub && !runner) return null;
  return (
    <Flex direction="column" gap="5" style={{ paddingBottom: 'var(--space-5)' }}>
      {hub && manifest.status !== 'idle' && (
        <>
          <Text size="1" style={{ color: 'var(--slate-11)' }}>
            {t('mcpHub.intro')} <Code>MCP_HUB</Code>
          </Text>
          <LoadState load={manifest} unavailableKey={manifestUnavailableKey(manifest)} onRetry={onReload}>
            {(data) => <ManifestSection instanceId={instanceId} manifest={data} onReplaced={onReplaced} onReload={onReload} />}
          </LoadState>
        </>
      )}
      {runner && <RunnerSection instanceId={instanceId} />}
    </Flex>
  );
}
