// Client IP extraction and CIDR matching for the player network allowlist.
import { isIPv4, isIPv6 } from 'node:net';

function ipv4ToBigInt(ip: string): bigint {
  return ip.split('.').reduce((acc, part) => (acc << 8n) + BigInt(Number(part)), 0n);
}

function ipv6ToBigInt(ip: string): bigint {
  let address = ip;
  // IPv4-mapped/embedded tail, e.g. ::ffff:192.168.1.10
  const v4Tail = address.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Tail) {
    const v4 = ipv4ToBigInt(v4Tail[1]);
    address = address.slice(0, -v4Tail[1].length) + `${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head, tail] = address.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const missing = 8 - headParts.length - tailParts.length;
  const parts = address.includes('::') ? [...headParts, ...Array(missing).fill('0'), ...tailParts] : headParts;
  return parts.reduce((acc, part) => (acc << 16n) + BigInt(parseInt(part || '0', 16)), 0n);
}

/** Normalises IPv4-mapped IPv6 (::ffff:a.b.c.d) to plain IPv4. */
export function normaliseIp(ip: string): string {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return mapped ? mapped[1] : ip;
}

export function ipInCidr(rawIp: string, cidr: string): boolean {
  const ip = normaliseIp(rawIp.trim());
  const [range, bitsText] = cidr.trim().split('/');
  if (isIPv4(ip) && isIPv4(range)) {
    const bits = bitsText === undefined ? 32 : Number(bitsText);
    if (bits === 0) return true;
    const mask = ((1n << 32n) - 1n) ^ ((1n << BigInt(32 - bits)) - 1n);
    return (ipv4ToBigInt(ip) & mask) === (ipv4ToBigInt(range) & mask);
  }
  if (isIPv6(ip) && isIPv6(range)) {
    const bits = bitsText === undefined ? 128 : Number(bitsText);
    if (bits === 0) return true;
    const mask = ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - bits)) - 1n);
    return (ipv6ToBigInt(ip) & mask) === (ipv6ToBigInt(range) & mask);
  }
  return false;
}

export function ipAllowed(ip: string, networks: string[]): boolean {
  return networks.some((cidr) => ipInCidr(ip, cidr));
}

/**
 * The socket address, or the right-most untrusted X-Forwarded-For entry when
 * the request came through a trusted proxy.
 */
export function clientIp(socketIp: string, forwardedFor: string | undefined, trustedProxies: string[]): string {
  const direct = normaliseIp(socketIp);
  if (!forwardedFor || !trustedProxies.some((proxy) => ipInCidr(direct, proxy))) {
    return direct;
  }
  const hops = forwardedFor.split(',').map((hop) => normaliseIp(hop.trim())).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!trustedProxies.some((proxy) => ipInCidr(hops[i], proxy))) return hops[i];
  }
  return hops[0] ?? direct;
}
