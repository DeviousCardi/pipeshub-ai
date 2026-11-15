import { request } from '@playwright/test';
import { test, expect } from '../fixtures/base.fixture';
import { getAccessToken } from '../fixtures/api-context.fixture';
import { apiBaseURL, SESSION_COOKIES, sessionFamily, signInOn } from '../helpers/session.helper';

/**
 * EM-65 (R44-IDENT, ADR-WEB-02 D9): every refresh replaces the session cookie; two tabs refreshing at once stay
 * signed in; a replaced cookie used after its 60 s grace ends that one sign-in, with one audit entry.
 *
 * No cookie or token value is ever printed: every comparison of one is reduced to a boolean before it is asserted.
 */

const REFRESH = '/api/v1/userAccount/refresh/token';
const REPLAY_KIND = 'identity.session_replayed';

interface Refreshed {
  status: number;
  /** The session cookie the answer set: a value, '' when it cleared the cookie, null when it set none. */
  cookie: string | null;
  accessToken: boolean;
}

/** One refresh with *cookie* and nothing else (no cookie jar), as a tab of the web app sends it. */
async function refresh(cookie: string): Promise<Refreshed> {
  const base = apiBaseURL();
  // ADR-WEB-02 D2: the __Host- name on https, the plain one on http.
  const name = new URL(base).protocol === 'https:' ? '__Host-pipeshub_refresh' : 'pipeshub_refresh';
  const res = await fetch(`${base}${REFRESH}`, {
    method: 'POST',
    headers: { cookie: `${name}=${cookie}`, origin: new URL(base).origin, 'content-type': 'application/json' },
    body: '{}',
  });
  let set: string | null = null;
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (!(SESSION_COOKIES as readonly string[]).includes(pair.slice(0, eq).trim())) continue;
    const value = pair.slice(eq + 1);
    set = value === '' || /max-age=0|1970/i.test(line) ? '' : value;
  }
  const body = (await res.json().catch(() => ({}))) as { accessToken?: string };
  return { status: res.status, cookie: set, accessToken: !!body.accessToken };
}

/** A sign-in of its own (another device): its session cookie. */
async function signInDevice(): Promise<string> {
  const api = await request.newContext({ baseURL: apiBaseURL() });
  try {
    return await signInOn(api, process.env.TEST_USER_EMAIL!, process.env.TEST_USER_PASSWORD!);
  } finally {
    await api.dispose();
  }
}

/** Every replay entry in the organisation's audit search, as a key per entry; null when the stack has no search. */
async function replayEntries(): Promise<string[] | null> {
  const api = await request.newContext({ baseURL: apiBaseURL(), extraHTTPHeaders: { Authorization: `Bearer ${getAccessToken()}` } });
  try {
    const out: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const res = await api.get('/api/v1/agent-harness/admin/audit/records', {
        params: { category: 'data_access', limit: 100, ...(cursor ? { cursor } : {}) },
      });
      if (res.status() === 404) return null;
      expect(res.status(), 'the audit search answers').toBe(200);
      const body = (await res.json()) as { items?: Record<string, unknown>[]; next?: string | null };
      out.push(...(body.items ?? []).filter((e) => e.kind === REPLAY_KIND).map((e) => JSON.stringify(e)));
      if (!body.next) return out;
      cursor = String(body.next);
    }
  } finally {
    await api.dispose();
  }
}

test.describe('Session rotation (EM-65)', () => {
  test.beforeEach(() => {
    expect(process.env.TEST_USER_EMAIL && process.env.TEST_USER_PASSWORD, 'TEST_USER_EMAIL and TEST_USER_PASSWORD must be set').toBeTruthy();
  });

  test('two tabs loading at once stay signed in, on the worker’s rotating session', async ({ context }) => {
    const [first, second] = [await context.newPage(), await context.newPage()];
    await Promise.all([first.goto('/chat/'), second.goto('/chat/')]);
    await Promise.all([first.waitForURL('**/chat/**', { timeout: 15_000 }), second.waitForURL('**/chat/**', { timeout: 15_000 })]);
    await Promise.all([first.reload(), second.reload()]);
    for (const tab of [first, second]) {
      await tab.waitForURL('**/chat/**', { timeout: 15_000 });
      await expect(tab.locator('#email-field')).toHaveCount(0);
    }
  });

  test.describe('over the refresh route', () => {
    // Its own sign-ins only: the worker's session is not touched.
    test.use({ storageState: { cookies: [], origins: [] } });

    test('two refreshes at once with one cookie both stay signed in, handed the same replacement', async () => {
      const a0 = await signInDevice();
      const answers = await Promise.all([refresh(a0), refresh(a0)]);
      expect(answers.map((a) => a.status), 'both tabs answered').toEqual([200, 200]);
      expect(answers.every((a) => a.accessToken), 'both get an access token').toBe(true);
      const [one, two] = answers.map((a) => a.cookie ?? '');
      expect(!!one && one === two, 'one replacement for both (one rotates, the other in the grace)').toBe(true);
      expect(one === a0, 'the cookie was replaced').toBe(false);
      expect(!!sessionFamily(a0) && sessionFamily(one) === sessionFamily(a0), 'the replacement keeps the sign-in').toBe(true);
    });

    // @slow: it waits out the 60 s grace. On its own worker the rest of the suite runs on.
    test('a cookie replayed after the grace ends that sign-in only, with one audit entry @slow', async () => {
      test.slow();
      const before = await replayEntries();

      const a0 = await signInDevice();
      const b0 = await signInDevice();
      expect(!!sessionFamily(a0) && sessionFamily(a0) !== sessionFamily(b0), 'two sign-ins are two session families').toBe(true);

      const r1 = await refresh(a0);
      expect(r1.status, 'the first refresh').toBe(200);
      const a1 = r1.cookie ?? '';
      const r2 = await refresh(a1);
      expect(r2.status === 200 && !!r2.cookie && r2.cookie !== a1, 'the current cookie refreshes and rotates again').toBe(true);
      const a2 = r2.cookie ?? '';
      expect((await refresh(a1)).status, 'the just-replaced cookie inside 60 s is answered (grace)').toBe(200);

      await new Promise((r) => setTimeout(r, 65_000));

      const replay = await refresh(a0);
      expect(replay.status, 'the old cookie replayed after the grace is refused').toBe(401);
      expect(replay.cookie === '', 'the refusal clears the cookie').toBe(true);
      expect((await refresh(a2)).status, 'that sign-in has ended: its current cookie is refused too').toBe(401);
      const other = await refresh(b0);
      expect(other.status === 200 && !!other.cookie, 'the other device stays signed in').toBe(true);
      expect((await refresh(a1)).status, 'a second replay is refused too').toBe(401);

      test.skip(before === null, 'this stack has no audit search (the harness admin routes are off)');
      let added: string[] = [];
      await expect
        .poll(async () => {
          const after = (await replayEntries()) ?? [];
          added = after.filter((e) => !before!.includes(e));
          return added.length;
        }, { message: 'a replay entry in the audit search', timeout: 20_000 })
        .toBeGreaterThanOrEqual(1);
      expect(added.length, 'exactly one replay entry (the first detection only)').toBe(1);
      expect([a0, a1, a2].some((t) => added[0].includes(t)), 'the entry holds a token').toBe(false);
    });
  });
});
