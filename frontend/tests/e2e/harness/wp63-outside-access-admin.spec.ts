/**
 * WP-63 on a real stack: the two admin screens for outside access, driven through the UI as an org admin.
 * No chat turn is sent and no model is called: the screens only read and save the org's policy sections.
 *
 *   01 websites     Allowed websites shows the presets off and saves "Package registries" on the revision read;
 *                   a site added read-only reads back through the policy route; read and write asks to confirm
 *   02 refusal      a git host typed as a website is refused on the page, and a server refusal is shown under
 *                   the field its dimension names (PipesHub's own address)
 *   03 restore      Changes lists the saves in words; "Restore this version" puts the first one back
 *   04 git hosts    Git hosts for cloning: github.com public repositories is off, turned on after a confirm;
 *                   a host with owner limits is added; the cache limits are shown, read only
 *
 * The org's `websites` and `repositories` sections are read first and put back afterwards (the policy route,
 * with `If-Match`). With WP63_SHOTS naming a directory, each case saves `wp63-<case>-<look>.png` there.
 */
import { existsSync, mkdirSync } from 'fs';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../fixtures/api-context.fixture';
import { adminApi } from '../helpers/labs-flag.helper';

test.describe.configure({ mode: 'serial' });

const CP = '/api/v1/control-plane/policy/org/current';
const SHOTS = process.env.WP63_SHOTS ?? '';
const LOOKS = [
  { name: 'desktop-light', width: 1280, height: 900, scheme: 'light' },
  { name: 'desktop-dark', width: 1280, height: 900, scheme: 'dark' },
  { name: 'phone-light', width: 390, height: 844, scheme: 'light' },
  { name: 'phone-dark', width: 390, height: 844, scheme: 'dark' },
] as const;

interface SectionBody {
  value: Record<string, unknown> | null;
  revision: number;
}

async function section(api: APIRequestContext, name: 'websites' | 'repositories'): Promise<SectionBody> {
  const response = await api.get(`${CP}/${name}`);
  expect(response.ok(), `reading ${name}: ${response.status()}`).toBe(true);
  return (await response.json()) as SectionBody;
}

async function putBack(api: APIRequestContext, name: 'websites' | 'repositories', value: SectionBody['value']): Promise<void> {
  const now = await section(api, name);
  const response = await api.put(`${CP}/${name}`, { data: { value }, headers: { 'If-Match': `"${String(now.revision)}"` } });
  expect(response.ok(), `restoring ${name}: ${response.status()}`).toBe(true);
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  for (const look of LOOKS) {
    await page.setViewportSize({ width: look.width, height: look.height });
    await page.emulateMedia({ colorScheme: look.scheme });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${SHOTS}/wp63-${name}-${look.name}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
}

// @disposable (round 15): it empties the org's allowed websites and git hosts while it runs and leaves its saves in
// their history, so it never runs on a stack people use; every lane stack runs it.
test.describe('WP-63 outside access, admin screens', { tag: '@disposable' }, () => {
  let websites: SectionBody['value'] = null;
  let repositories: SectionBody['value'] = null;

  test.beforeAll(async () => {
    const api = await adminApi();
    websites = (await section(api, 'websites')).value;
    repositories = (await section(api, 'repositories')).value;
    // Each case starts from an org that allows nothing (the default).
    await putBack(api, 'websites', { sites: [] });
    await putBack(api, 'repositories', { hosts: [] });
  });

  test.afterAll(async () => {
    const api = await adminApi();
    await putBack(api, 'websites', websites);
    await putBack(api, 'repositories', repositories);
  });

  test('WP63-01: presets and sites save through the policy route; read and write asks first', async ({ page, apiContext }) => {
    await page.goto('/workspace/allowed-websites/');
    await expect(page.getByRole('heading', { name: 'Allowed websites', level: 1 })).toBeVisible({ timeout: 30_000 });
    const registries = page.getByRole('switch', { name: 'Package registries' });
    await expect(registries).toHaveAttribute('aria-checked', 'false');
    const put = page.waitForResponse((r) => r.url().endsWith(`${CP}/websites`) && r.request().method() === 'PUT');
    await registries.click();
    expect((await put).status()).toBe(200);
    await expect(registries).toHaveAttribute('aria-checked', 'true');

    const add = page.getByRole('group', { name: 'Add a site' });
    await add.getByLabel('Site').fill('docs.example.com');
    await add.getByLabel('Limit to these paths').fill('/api/');
    await add.getByRole('button', { name: 'Add' }).click();
    await expect(page.getByRole('group', { name: 'Your sites' }).getByText('docs.example.com')).toBeVisible();

    await add.getByLabel('Site').fill('mirror.example.net');
    await add.getByRole('combobox', { name: 'Access' }).click();
    await page.getByRole('option', { name: 'Read and write' }).click();
    await add.getByRole('button', { name: 'Add' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Let agents send data to mirror.example.net?' });
    await expect(confirm.getByRole('button', { name: 'Allow read and write' })).toBeDisabled();
    await shoot(page, '01-confirm');
    await confirm.getByRole('checkbox').click();
    await confirm.getByRole('button', { name: 'Allow read and write' }).click();
    await expect(confirm).toBeHidden();

    const stored = (await (await apiContext.get(`${CP}/websites`)).json()) as SectionBody;
    const sites = (stored.value?.sites ?? []) as Array<Record<string, unknown>>;
    expect(sites.find((s) => s.host === 'docs.example.com')).toEqual({ host: 'docs.example.com', access: 'read', paths: ['/api/'] });
    expect(sites.find((s) => s.host === 'mirror.example.net')).toEqual({ host: 'mirror.example.net', access: 'read-write', readWriteConfirmed: true });
    expect(sites.filter((s) => s.preset === 'package-registries').length).toBeGreaterThan(0);
    await page.reload();
    await expect(page.getByRole('switch', { name: 'Package registries' })).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
    await shoot(page, '01-websites');
  });

  test('WP63-02: a git host is refused on the page; a server refusal shows under its field', async ({ page }) => {
    await page.goto('/workspace/allowed-websites/');
    const add = page.getByRole('group', { name: 'Add a site' });
    await expect(add).toBeVisible({ timeout: 30_000 });
    await add.getByLabel('Site').fill('github.com');
    await add.getByRole('button', { name: 'Add' }).click();
    await expect(add.getByText(/Git hosts are never websites/)).toBeVisible();
    // The stack's own host is refused by the server, never by the page: the server names the field.
    const own = new URL(page.url()).hostname;
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(own)) {
      await add.getByLabel('Site').fill(own);
      const put = page.waitForResponse((r) => r.url().endsWith(`${CP}/websites`) && r.request().method() === 'PUT');
      await add.getByRole('button', { name: 'Add' }).click();
      expect((await put).status()).toBe(422);
      await expect(add.getByRole('alert')).toBeVisible();
    }
    await shoot(page, '02-refusal');
  });

  test('WP63-03: Changes lists the saves; Restore this version puts an earlier one back', async ({ page, apiContext }) => {
    await page.goto('/workspace/allowed-websites/');
    await page.getByRole('button', { name: 'Changes' }).click({ timeout: 30_000 });
    const list = page.getByRole('list', { name: 'Changes' });
    await expect(list.getByRole('listitem').first()).toContainText('Added mirror.example.net, read and write');
    await shoot(page, '03-changes');
    const row = list.getByRole('listitem').filter({ hasText: 'Turned on Package registries' }).first();
    const post = page.waitForResponse((r) => r.url().endsWith(`${CP}/websites/rollback`));
    await row.getByRole('button', { name: 'Restore this version' }).click();
    expect((await post).status()).toBe(200);
    const stored = (await (await apiContext.get(`${CP}/websites`)).json()) as SectionBody;
    const sites = (stored.value?.sites ?? []) as Array<Record<string, unknown>>;
    expect(sites.some((s) => s.host === 'mirror.example.net')).toBe(false);
    expect(sites.some((s) => s.preset === 'package-registries')).toBe(true);
  });

  test('WP63-04: git hosts: the github.com preset after a confirm, a host with owner limits, the cache read only', async ({ page, apiContext }) => {
    await page.goto('/workspace/git-hosts/');
    await expect(page.getByRole('heading', { name: 'Git hosts for cloning', level: 1 })).toBeVisible({ timeout: 30_000 });
    const preset = page.getByRole('switch', { name: 'github.com public repositories' });
    await expect(preset).toHaveAttribute('aria-checked', 'false');
    await preset.click();
    const confirm = page.getByRole('alertdialog', { name: 'Turn on public repositories from github.com?' });
    await shoot(page, '04-confirm');
    await confirm.getByRole('button', { name: 'Turn on' }).click();
    await expect(preset).toHaveAttribute('aria-checked', 'true');

    const add = page.getByRole('group', { name: 'Add a git host' });
    await add.getByLabel('Git host').fill('gitlab.com');
    await add.getByLabel('Only these owners or repositories').fill('gitlab-org/');
    await add.getByRole('button', { name: 'Add' }).click();
    await expect(page.getByRole('group', { name: 'Other hosts and limits' }).getByText('gitlab-org/')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Storage' }).getByRole('textbox')).toHaveCount(0);

    const stored = (await (await apiContext.get(`${CP}/repositories`)).json()) as SectionBody;
    expect(stored.value).toEqual({ hosts: [{ host: 'github.com', preset: 'github-public' }, { host: 'gitlab.com', prefixes: ['gitlab-org/'] }] });
    await shoot(page, '04-git-hosts');
  });
});
