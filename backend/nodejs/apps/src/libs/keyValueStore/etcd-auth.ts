import { X509Certificate } from 'crypto';
import { readFileSync } from 'fs';
import type { AuthClient } from 'etcd3';
import type { EtcdTlsFiles } from './etcd-tls';

/** A key a role may read or write: an exact key when `rangeEnd` is empty. */
export interface EtcdPermission {
  key: string;
  rangeEnd: string;
  permission: 'Read' | 'Write' | 'Readwrite';
}

/**
 * etcd's role-based auth, as far as Node applies it (R38IDENT-FU-9). With `--client-cert-auth` etcd names a client by
 * its certificate's CN; `ownUser` is this process's. Missing users and roles answer null rather than throw.
 */
export interface EtcdAuthAdmin {
  readonly ownUser: string;
  authEnabled(): Promise<boolean>;
  enableAuth(): Promise<void>;
  userRoles(user: string): Promise<string[] | null>;
  /** A user without a password: it can only be the CN of a certificate etcd's CA signed. */
  addUser(user: string): Promise<void>;
  grantRole(user: string, role: string): Promise<void>;
  revokeRole(user: string, role: string): Promise<void>;
  rolePermissions(role: string): Promise<EtcdPermission[] | null>;
  addRole(role: string): Promise<void>;
  grantPermission(role: string, permission: EtcdPermission): Promise<void>;
  revokePermission(role: string, key: string, rangeEnd: string): Promise<void>;
}

/** The CN of this process's etcd client certificate, or null without one. */
export function etcdClientUser(tls: EtcdTlsFiles | undefined): string | null {
  if (!tls) return null;
  const subject = new X509Certificate(readFileSync(tls.certFile)).subject;
  const cn = subject
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part.startsWith('CN='));
  return cn ? cn.slice(3) : null;
}

const notFound = (error: unknown): boolean =>
  error instanceof Error && /not found/i.test(error.message);

export class Etcd3AuthAdmin implements EtcdAuthAdmin {
  constructor(
    private readonly auth: AuthClient,
    readonly ownUser: string,
  ) {}

  async authEnabled(): Promise<boolean> {
    return (await this.auth.authStatus()).enabled === true;
  }

  async enableAuth(): Promise<void> {
    await this.auth.authEnable();
  }

  async userRoles(user: string): Promise<string[] | null> {
    try {
      return (await this.auth.userGet({ name: user })).roles ?? [];
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }

  async addUser(user: string): Promise<void> {
    await this.auth.userAdd({ name: user, options: { no_password: true } });
  }

  async grantRole(user: string, role: string): Promise<void> {
    await this.auth.userGrantRole({ user, role });
  }

  async revokeRole(user: string, role: string): Promise<void> {
    await this.auth.userRevokeRole({ name: user, role });
  }

  async rolePermissions(role: string): Promise<EtcdPermission[] | null> {
    try {
      const { perm } = await this.auth.roleGet({ role });
      return (perm ?? []).map((p) => ({
        key: Buffer.from(p.key ?? '').toString('utf8'),
        rangeEnd: Buffer.from(p.range_end ?? '').toString('utf8'),
        permission: p.permType,
      }));
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  }

  async addRole(role: string): Promise<void> {
    await this.auth.roleAdd({ name: role });
  }

  async grantPermission(
    role: string,
    permission: EtcdPermission,
  ): Promise<void> {
    await this.auth.roleGrantPermission({
      name: role,
      perm: {
        permType: permission.permission,
        key: Buffer.from(permission.key, 'utf8'),
        range_end: Buffer.from(permission.rangeEnd, 'utf8'),
      },
    });
  }

  async revokePermission(
    role: string,
    key: string,
    rangeEnd: string,
  ): Promise<void> {
    await this.auth.roleRevokePermission({
      role,
      key: Buffer.from(key, 'utf8'),
      range_end: Buffer.from(rangeEnd, 'utf8'),
    });
  }
}
