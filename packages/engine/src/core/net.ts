/**
 * Which hosts are this machine, and which are on a private network. Two rules for loopback, because
 * two questions are asked:
 *
 * - isLoopbackAddress decides who may reach the HTTP API (the bind address, the token requirement).
 *   It is strict: it accepts only addresses that cannot leave the machine.
 * - isLoopbackHost decides what leaves the machine or costs money (egress reports, price of a local
 *   model, warnings about plain http). It also takes names such as "app.localhost".
 */
import { isIP } from 'node:net';

/** A host without the brackets of an IPv6 address. */
function withoutBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * true for an address that only this machine can reach: "localhost", "::1", an IPv4 address in
 * 127.0.0.0/8, and the IPv6 form of such an address ("::ffff:127.0.0.1"). The host is given alone,
 * without a port. "0.0.0.0" and "::" listen on every interface, so they are not loopback, and a
 * name below "localhost" is not either: a name can be made to point anywhere.
 */
export function isLoopbackAddress(host: string): boolean {
  const name = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (name === 'localhost' || name === '::1') return true;
  if (name.startsWith('::ffff:')) return isLoopbackAddress(name.slice('::ffff:'.length));
  return isIP(name) === 4 && name.startsWith('127.');
}

/** "localhost", names below it, and loopback IP literals, written as in a URL: with or without a port. */
function isLoopbackUrlHost(host: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  const ip = withoutBrackets(hostname);
  if (isIP(ip) === 4) return ip.startsWith('127.');
  if (isIP(ip) === 6) return ip === '::1';
  return false;
}

/**
 * true for a host that is this machine, as written in a URL ("localhost:11434", "[::1]:8080",
 * "app.localhost") or as a bare address (see isLoopbackAddress). Only complete IP addresses count:
 * "127.0.0.1.example.com" is an ordinary public host. For egress and warnings only: who may reach
 * the HTTP API is decided by isLoopbackAddress.
 */
export function isLoopbackHost(host: string): boolean {
  return isLoopbackUrlHost(host) || isLoopbackAddress(host);
}

/** Loopback, private-range and intranet-style host names (where plain http is acceptable). */
export function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (isLoopbackHost(h)) return true;
  const ip = withoutBrackets(h);
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31)
    );
  }
  if (isIP(ip) === 6) return /^(?:fc|fd|fe[89ab])/.test(ip);
  // Reserved and intranet-style names, and single-label names such as "ollama" in a compose network.
  if (/\.(local|internal|lan|home|intranet)$/.test(h)) return true;
  return !h.includes('.');
}
