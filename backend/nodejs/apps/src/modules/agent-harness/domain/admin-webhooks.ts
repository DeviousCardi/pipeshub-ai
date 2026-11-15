import { BlockList, isIP } from 'node:net';

/**
 * What every admin-configured outside endpoint shares: an https URL with no
 * credentials in it, and a header the admin gives (a vendor token, a gateway
 * key) instead of key material of our own.
 */
export interface AuthHeader {
  readonly name: string;
  /** Write-only: never returned by the API or written to the audit chain. */
  readonly value: string;
}

/** What an admin reads back: a header's name and whether it has a value, never the value. */
export interface AuthHeaderView {
  readonly name: string;
  readonly hasValue: true;
}

export const authHeaderView = (h: AuthHeader | null): AuthHeaderView | null =>
  h === null ? null : { name: h.name, hasValue: true };

/** A setting an admin gave that cannot be stored; its message is the admin's to read. */
export class AdminWebhookSettingsError extends RangeError {}

// RFC 7230 token: what a header name may hold.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
// Headers the transport owns; an admin's header never replaces them.
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
]);

export function isHeaderName(name: string): boolean {
  return HEADER_NAME.test(name) && !RESERVED_HEADERS.has(name.toLowerCase());
}

/** `https://` only, no userinfo, no fragment: the URL an admin may give an outside endpoint. */
export function webhookUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'The URL is not valid';
  }
  if (url.protocol !== 'https:') return 'The URL must start with https://';
  if (url.username !== '' || url.password !== '') {
    return 'Put credentials in the header, not the URL';
  }
  if (url.hash !== '') return 'The URL must not have a fragment';
  return null;
}

/** The header to store: `update` checked, or the stored one when absent; null removes it. */
export function checkedHeader(
  update: AuthHeader | null | undefined,
  stored: AuthHeader | null,
): AuthHeader | null {
  if (update === undefined) return stored;
  if (update === null) return null;
  if (!isHeaderName(update.name)) {
    throw new AdminWebhookSettingsError('The header name is not valid');
  }
  if (
    update.value.length === 0 ||
    update.value.length > 4096 ||
    /[\r\n]/.test(update.value)
  ) {
    throw new AdminWebhookSettingsError('The header value is not valid');
  }
  return { name: update.name, value: update.value };
}

export function checkedUrl(url: string): string {
  const problem = webhookUrlProblem(url);
  if (problem !== null) throw new AdminWebhookSettingsError(problem);
  return url;
}

/**
 * Addresses no admin-configured endpoint may reach (loopback, link-local and
 * cloud metadata, multicast, unspecified), and, when the deployment blocks
 * private addresses (`PIPESHUB_BLOCK_PRIVATE_ADDRESSES`, as Python reads it),
 * private ones too. A self-hosted collector usually sits on the private
 * network, so private addresses are allowed by default.
 */
const NEVER = new BlockList();
NEVER.addSubnet('127.0.0.0', 8, 'ipv4');
NEVER.addSubnet('0.0.0.0', 8, 'ipv4');
NEVER.addSubnet('169.254.0.0', 16, 'ipv4');
NEVER.addSubnet('224.0.0.0', 4, 'ipv4');
NEVER.addSubnet('240.0.0.0', 4, 'ipv4');
NEVER.addAddress('::1', 'ipv6');
NEVER.addAddress('::', 'ipv6');
NEVER.addSubnet('fe80::', 10, 'ipv6');
NEVER.addSubnet('ff00::', 8, 'ipv6');
NEVER.addAddress('fd00:ec2::254', 'ipv6');
const PRIVATE = new BlockList();
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addSubnet('100.64.0.0', 10, 'ipv4');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');

const SWITCH_ON = new Set(['true', '1', 'yes', 'on']);

export function privateAddressesBlocked(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env['PIPESHUB_BLOCK_PRIVATE_ADDRESSES'] ?? '';
  return SWITCH_ON.has(raw.trim().toLowerCase());
}

/** Why `address` may not be contacted, or null. An IPv4-mapped IPv6 address is judged by its IPv4 address. */
export function addressRefusal(
  address: string,
  options: { readonly allowPrivate: boolean },
): string | null {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const ip = mapped?.[1] ?? address;
  const family = isIP(ip);
  if (family === 0) return 'not an IP address';
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (NEVER.check(ip, type))
    return 'a loopback, link-local or metadata address';
  if (!options.allowPrivate && PRIVATE.check(ip, type)) {
    return 'a private address, which this deployment blocks';
  }
  return null;
}
