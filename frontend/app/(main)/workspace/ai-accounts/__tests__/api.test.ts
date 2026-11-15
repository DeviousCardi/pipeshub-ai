/**
 * U2 AC-1..AC-7: the API client of the accounts pages. Every response is
 * mapped field by field and every failure becomes one of the states the
 * pages render; the pages show their own errors, so no global toast.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '@/lib/api';
import { ModelAccountsApi, toAccountsError } from '../api';

vi.mock('@/lib/api', () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const get = vi.mocked(apiClient.get);
const post = vi.mocked(apiClient.post);
const put = vi.mocked(apiClient.put);
const del = vi.mocked(apiClient.delete);

const QUIET = { suppressErrorToast: true };

const account = (over: Record<string, unknown> = {}) => ({
  id: 'openAI',
  accountRef: { kind: 'user_api_key', accountId: 'users/u1/openAI' },
  provider: 'openAI',
  label: null,
  last4: 'WXYZ',
  version: 2,
  createdAt: '2026-10-01T10:00:00.000Z',
  rotatedAt: '2026-10-02T10:00:00.000Z',
  validation: 'unvalidated',
  ...over,
});

const rule = (over: Record<string, unknown> = {}) => ({
  id: 'openai-api-key-user',
  provider: 'openai',
  accountKind: 'user_api_key',
  route: 'gateway',
  engines: null,
  status: 'allowed',
  consumer: false,
  source: 'https://openai.com/policies',
  built: true,
  outcome: 'allowed',
  ...over,
});

const refused = (statusCode: number | undefined, message = '') => ({ type: 'X', statusCode, message });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ModelAccountsApi', () => {
  it('AC-1: lists the caller’s keys field by field; bad entries dropped, extra fields never kept', async () => {
    get.mockResolvedValueOnce({
      data: {
        accounts: [
          account({ apiKey: 'sk-should-never-surface', ciphertext: 'x' }),
          { id: 'broken' },
          account({ accountRef: { kind: 'org_api_key', accountId: 'x' } }),
        ],
      },
    });
    const accounts = await ModelAccountsApi.listOwn();
    expect(get).toHaveBeenCalledWith('/api/v1/agent-harness/model-accounts/me', QUIET);
    expect(accounts).toEqual([
      {
        id: 'openAI',
        accountRef: { kind: 'user_api_key', accountId: 'users/u1/openAI' },
        provider: 'openAI',
        label: null,
        last4: 'WXYZ',
        version: 2,
        createdAt: '2026-10-01T10:00:00.000Z',
        rotatedAt: '2026-10-02T10:00:00.000Z',
        validation: 'unvalidated',
      },
    ]);
    expect(JSON.stringify(accounts)).not.toContain('sk-should-never-surface');
  });

  it('AC-2: puts a key under its provider (encoded) and returns the metadata', async () => {
    put.mockResolvedValueOnce({ data: account() });
    const view = await ModelAccountsApi.putOwn('open/AI', 'sk-secret', 'Work');
    expect(put).toHaveBeenCalledWith(
      '/api/v1/agent-harness/model-accounts/me/open%2FAI',
      { apiKey: 'sk-secret', label: 'Work' },
      QUIET,
    );
    expect(view?.last4).toBe('WXYZ');
  });

  it('AC-3: removes by provider', async () => {
    del.mockResolvedValueOnce({ data: '' });
    await ModelAccountsApi.removeOwn('anthropic');
    expect(del).toHaveBeenCalledWith('/api/v1/agent-harness/model-accounts/me/anthropic', QUIET);
  });

  it.each([
    ['503 on a read', refused(503, 'store down'), false, { kind: 'unavailable', status: 503, message: null }],
    ['no response (network)', refused(undefined, 'Network error'), false, { kind: 'unavailable', status: null, message: null }],
    ['403', refused(403, 'Model keys are managed by the user'), true, { kind: 'forbidden', status: 403, message: null }],
    ['400 from userAdminCheck', refused(400, 'Admin access required'), false, { kind: 'forbidden', status: 400, message: null }],
    ['400 on a write', refused(400, 'apiKey: This is not an OpenAI API key.'), true, {
      kind: 'invalid',
      status: 400,
      message: 'apiKey: This is not an OpenAI API key.',
    }],
    ['404', refused(404, 'gone'), true, { kind: 'not_found', status: 404, message: null }],
    ['500', refused(500, 'boom'), false, { kind: 'failed', status: 500, message: null }],
  ])('AC-4: %s', (_name, error, write, expected) => {
    expect(toAccountsError(error, write)).toEqual(expected);
  });

  it('AC-4: a failed call rejects with the mapped error', async () => {
    get.mockRejectedValueOnce(refused(503));
    await expect(ModelAccountsApi.listOwn()).rejects.toEqual({ kind: 'unavailable', status: 503, message: null });
    put.mockRejectedValueOnce(refused(400, 'apiKey: This is not an Anthropic API key.'));
    await expect(ModelAccountsApi.putOwn('anthropic', 'k', null)).rejects.toMatchObject({
      kind: 'invalid',
      message: 'apiKey: This is not an Anthropic API key.',
    });
  });

  it('AC-5: maps the access view; an unknown outcome is kept as unknown, malformed rows dropped', async () => {
    get.mockResolvedValueOnce({
      data: {
        version: '2026-10-02.1',
        offering: 'managed',
        policy: { disabledRules: ['gemini-api-key-user', 7], consumerPlans: false },
        rules: [
          rule(),
          rule({ id: 'future', outcome: 'something_new', status: 'mystery', engines: ['codex', 3] }),
          rule({ accountKind: 'not_a_kind' }),
          'junk',
        ],
      },
    });
    const view = await ModelAccountsApi.access();
    expect(get).toHaveBeenCalledWith('/api/v1/agent-harness/model-accounts/access', QUIET);
    expect(view.version).toBe('2026-10-02.1');
    expect(view.offering).toBe('managed');
    expect(view.policy).toEqual({ disabledRules: ['gemini-api-key-user'], consumerPlans: false });
    expect(view.rules.map((r) => r.id)).toEqual(['openai-api-key-user', 'future']);
    expect(view.rules[1]).toMatchObject({ outcome: 'unknown', status: 'unknown', engines: ['codex'] });
  });

  it('AC-6: admin cloud accounts, model access and engine profile calls', async () => {
    post.mockResolvedValueOnce({ data: account({ id: 'c1', accountRef: { kind: 'org_cloud', accountId: 'cloud/c1' } }) });
    const created = await ModelAccountsApi.createOrg({
      provider: 'azureOpenAI',
      label: 'Prod',
      credentials: { endpoint: 'https://x.openai.azure.com', deploymentName: 'gpt', apiKey: 'k' },
    });
    expect(post).toHaveBeenCalledWith(
      '/api/v1/agent-harness/admin/model-accounts',
      { provider: 'azureOpenAI', label: 'Prod', credentials: { endpoint: 'https://x.openai.azure.com', deploymentName: 'gpt', apiKey: 'k' } },
      QUIET,
    );
    expect(created?.accountRef).toEqual({ kind: 'org_cloud', accountId: 'cloud/c1' });

    put.mockResolvedValueOnce({ data: account() });
    await ModelAccountsApi.rotateOrg('c1', { label: null, credentials: { apiKey: 'k2' } });
    expect(put).toHaveBeenLastCalledWith(
      '/api/v1/agent-harness/admin/model-accounts/c1',
      { label: null, credentials: { apiKey: 'k2' } },
      QUIET,
    );

    del.mockResolvedValueOnce({ data: '' });
    await ModelAccountsApi.removeOrg('c1');
    expect(del).toHaveBeenLastCalledWith('/api/v1/agent-harness/admin/model-accounts/c1', QUIET);

    put.mockResolvedValueOnce({ data: { version: 'v', offering: 'oss', policy: {}, rules: [] } });
    await ModelAccountsApi.putAdminAccess({ disabledRules: ['b', 'a', 'b'], consumerPlans: true });
    expect(put).toHaveBeenLastCalledWith(
      '/api/v1/agent-harness/admin/model-access',
      { disabledRules: ['a', 'b'], consumerPlans: true },
      QUIET,
    );

    get.mockResolvedValueOnce({
      data: {
        ceiling: { mode: 'plan', accountKinds: ['org_api_key'] },
        defaults: [
          { engine: { kind: 'opencode' }, accountKinds: ['org_api_key', 'user_api_key'] },
          { engine: { kind: 'codex' }, accountKinds: ['org_cloud', 'bogus'] },
        ],
      },
    });
    const engine = await ModelAccountsApi.engineProfile();
    expect(get).toHaveBeenLastCalledWith('/api/v1/agent-harness/admin/engine-profile', QUIET);
    expect(engine).toMatchObject({
      ceiling: { mode: 'plan', accountKinds: ['org_api_key'] },
      releaseAccountKinds: ['org_api_key', 'org_cloud', 'user_api_key'],
    });
    expect(engine.releases.map((release) => [release.kind, release.accountKinds])).toEqual([
      ['opencode', ['org_api_key', 'user_api_key']],
      ['codex', ['org_cloud']],
    ]);

    put.mockResolvedValueOnce({ data: { ceiling: null, defaults: [] } });
    await ModelAccountsApi.putEngineProfile(null);
    expect(put).toHaveBeenLastCalledWith('/api/v1/agent-harness/admin/engine-profile', { ceiling: null }, QUIET);
  });

  it('AC-7: every call suppresses the global error toast', async () => {
    get.mockResolvedValue({ data: {} });
    put.mockResolvedValue({ data: {} });
    post.mockResolvedValue({ data: {} });
    del.mockResolvedValue({ data: '' });
    await ModelAccountsApi.listOwn();
    await ModelAccountsApi.access();
    await ModelAccountsApi.listOrg();
    await ModelAccountsApi.adminAccess();
    await ModelAccountsApi.engineProfile();
    await ModelAccountsApi.putOwn('openAI', 'k', null);
    await ModelAccountsApi.removeOwn('openAI');
    await ModelAccountsApi.createOrg({ provider: 'bedrock', label: null, credentials: {} });
    await ModelAccountsApi.rotateOrg('c', { label: null, credentials: {} });
    await ModelAccountsApi.removeOrg('c');
    await ModelAccountsApi.putAdminAccess({ disabledRules: [], consumerPlans: false });
    await ModelAccountsApi.putEngineProfile(null);
    const configs = [...get.mock.calls, ...del.mock.calls].map((call) => call[1]);
    const bodyConfigs = [...put.mock.calls, ...post.mock.calls].map((call) => call[2]);
    expect([...configs, ...bodyConfigs]).toHaveLength(12);
    for (const config of [...configs, ...bodyConfigs]) expect(config).toEqual(QUIET);
  });
});
