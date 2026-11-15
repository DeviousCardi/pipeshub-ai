import type {
  CodingEnginePreferences,
  StoredCodingEngines,
} from '../ports/coding-engines';
import type { SessionRepository } from '../domain/repository';

/** The coding-engine choices in memory (tests and the in-memory composition). */
export class InMemoryCodingEnginePreferences implements CodingEnginePreferences {
  private readonly users = new Map<string, string>();
  private readonly orgs = new Map<string, string>();
  private readonly sessions = new Map<string, string>();
  private readonly pins = new Map<string, string>();
  private readonly repositories = new Map<string, SessionRepository>();

  private readonly routingOff = new Set<string>();

  read(orgId: string, userId: string): Promise<StoredCodingEngines> {
    return Promise.resolve({
      user: this.users.get(`${orgId}/${userId}`) ?? null,
      org: this.orgs.get(orgId) ?? null,
      orgAutoRoute: !this.routingOff.has(orgId),
    });
  }

  writeOrgAutoRoute(orgId: string, on: boolean): Promise<void> {
    if (on) this.routingOff.delete(orgId);
    else this.routingOff.add(orgId);
    return Promise.resolve();
  }

  writeUser(
    orgId: string,
    userId: string,
    choice: string | null,
  ): Promise<void> {
    if (choice === null) this.users.delete(`${orgId}/${userId}`);
    else this.users.set(`${orgId}/${userId}`, choice);
    return Promise.resolve();
  }

  writeOrg(orgId: string, engine: string | null): Promise<void> {
    if (engine === null) this.orgs.delete(orgId);
    else this.orgs.set(orgId, engine);
    return Promise.resolve();
  }

  readSession(orgId: string, sessionId: string): Promise<string | null> {
    return Promise.resolve(this.sessions.get(`${orgId}/${sessionId}`) ?? null);
  }

  writeSession(
    orgId: string,
    sessionId: string,
    choice: string | null,
  ): Promise<void> {
    if (choice === null) this.sessions.delete(`${orgId}/${sessionId}`);
    else this.sessions.set(`${orgId}/${sessionId}`, choice);
    return Promise.resolve();
  }

  readSessionPin(orgId: string, sessionId: string): Promise<string | null> {
    return Promise.resolve(this.pins.get(`${orgId}/${sessionId}`) ?? null);
  }

  writeSessionPin(
    orgId: string,
    sessionId: string,
    engine: string | null,
  ): Promise<void> {
    if (engine === null) this.pins.delete(`${orgId}/${sessionId}`);
    else this.pins.set(`${orgId}/${sessionId}`, engine);
    return Promise.resolve();
  }

  readSessionRepository(
    orgId: string,
    sessionId: string,
  ): Promise<SessionRepository | null> {
    const stored = this.repositories.get(`${orgId}/${sessionId}`);
    return Promise.resolve(stored === undefined ? null : { ...stored });
  }

  writeSessionRepository(
    orgId: string,
    sessionId: string,
    repository: SessionRepository | null,
  ): Promise<void> {
    if (repository === null) this.repositories.delete(`${orgId}/${sessionId}`);
    else this.repositories.set(`${orgId}/${sessionId}`, { ...repository });
    return Promise.resolve();
  }

  eraseUser(orgId: string, userId: string): Promise<number> {
    return Promise.resolve(this.users.delete(`${orgId}/${userId}`) ? 1 : 0);
  }

  eraseSession(orgId: string, sessionId: string): Promise<number> {
    const key = `${orgId}/${sessionId}`;
    const removed = [this.sessions, this.pins, this.repositories]
      .map((records) => records.delete(key))
      .some(Boolean);
    return Promise.resolve(removed ? 1 : 0);
  }
}
