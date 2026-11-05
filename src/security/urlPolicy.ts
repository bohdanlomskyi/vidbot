import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

/**
 * Operator-defined rules for an outbound stream URL. Hosts are an exact allowlist,
 * never a pattern. Private and reserved addresses are rejected even when listed.
 */
export interface StreamUrlPolicy {
  /** Lowercase host names or IP literals that may be used. */
  readonly allowedHosts: readonly string[];
  readonly allowHttp: boolean;
  readonly allowedPorts: readonly number[];
}

export type UrlRejectionReason =
  | 'TOO_LONG'
  | 'INVALID_URL'
  | 'UNSUPPORTED_SCHEME'
  | 'CREDENTIALS_NOT_ALLOWED'
  | 'PORT_NOT_ALLOWED'
  | 'PRIVATE_ADDRESS'
  | 'HOST_NOT_ALLOWED';

export type UrlCheckResult =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly reason: UrlRejectionReason };

const MAX_URL_LENGTH = 2048;

/** Validates a stream URL against the policy. It performs no network I/O. */
export function checkStreamUrl(raw: string, policy: StreamUrlPolicy): UrlCheckResult {
  if (raw.length > MAX_URL_LENGTH) {
    return { ok: false, reason: 'TOO_LONG' };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'INVALID_URL' };
  }

  const schemeAllowed = url.protocol === 'https:' || (url.protocol === 'http:' && policy.allowHttp);
  if (!schemeAllowed) {
    return { ok: false, reason: 'UNSUPPORTED_SCHEME' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'CREDENTIALS_NOT_ALLOWED' };
  }

  const defaultPort = url.protocol === 'https:' ? 443 : 80;
  const port = url.port === '' ? defaultPort : Number(url.port);
  if (!policy.allowedPorts.includes(port)) {
    return { ok: false, reason: 'PORT_NOT_ALLOWED' };
  }

  const host = stripBrackets(url.hostname).toLowerCase();
  if (isIP(host) !== 0 && !isPublicIp(host)) {
    return { ok: false, reason: 'PRIVATE_ADDRESS' };
  }
  if (!policy.allowedHosts.includes(host)) {
    return { ok: false, reason: 'HOST_NOT_ALLOWED' };
  }

  return { ok: true, url };
}

/** True only for globally routable unicast addresses. Anything else, including non-IP text, is false. */
export function isPublicIp(address: string): boolean {
  if (isIP(address) === 0) {
    return false;
  }
  try {
    // `process` converts IPv4-mapped IPv6 addresses to IPv4 before classifying them.
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}

export type AddressSelection =
  | { readonly ok: true; readonly address: string; readonly family: 4 | 6 }
  | { readonly ok: false; readonly reason: 'NO_ADDRESS' | 'PRIVATE_ADDRESS' };

export interface ResolvedRecord {
  readonly address: string;
  readonly family: number;
}

/**
 * Picks the address to connect to from a DNS answer. If any returned address is
 * non-public, the whole answer is refused. Mixed answers are a common sign of DNS
 * rebinding, so failing closed is safer than choosing the public one.
 */
export function selectPublicAddress(records: readonly ResolvedRecord[]): AddressSelection {
  const [first] = records;
  if (first === undefined) {
    return { ok: false, reason: 'NO_ADDRESS' };
  }
  if (!records.every((record) => isPublicIp(record.address))) {
    return { ok: false, reason: 'PRIVATE_ADDRESS' };
  }
  return { ok: true, address: first.address, family: first.family === 6 ? 6 : 4 };
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}
