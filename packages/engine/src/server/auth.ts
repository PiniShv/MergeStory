/** Bearer-token authentication and host checks for the HTTP API. */
import { createHash, timingSafeEqual } from 'node:crypto';
import { MergeStoryError } from '../core/errors.ts';

/** Hash first so both buffers have the same length: the comparison then reveals neither the token nor its length. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Checks the Authorization header of a request. */
export interface Authenticator {
  /** true when the Authorization header carries the right bearer token. */
  check(header: string | undefined): boolean;
}

/** An authenticator for one bearer token. */
export function createAuthenticator(token: string): Authenticator {
  const expected = digest(token);
  return {
    check(header) {
      const match = /^Bearer ([^\s]+)$/i.exec(header ?? '');
      // Always compare something, so a missing header takes as long as a wrong one.
      const given = digest(match?.[1] ?? '');
      return timingSafeEqual(expected, given) && match !== null;
    },
  };
}

/** A host name the way it is compared: lower case, without the brackets of an IPv6 address. */
function normalizeHost(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
}

/** A DNS name or an IP address, without a scheme, port or path. */
const HOST_NAME = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|[0-9a-f:.]+)$/;

/**
 * Host names a browser may legitimately use to reach a loopback-only server: the loopback names,
 * the bound address, and `extra` names, for a reverse proxy that passes on the name it was reached by.
 */
export function allowedHostNames(boundHost: string, extra: readonly string[] = []): Set<string> {
  const names = new Set(['localhost', '127.0.0.1', '::1', normalizeHost(boundHost)]);
  for (const name of extra) {
    const host = normalizeHost(name);
    if (!HOST_NAME.test(host)) {
      throw new MergeStoryError('USAGE', `${JSON.stringify(name.slice(0, 100))} is not a host name.`, {
        hint: 'Give the name alone, without a scheme, port or path, for example mergestory.example.com.',
      });
    }
    names.add(host);
  }
  return names;
}

/**
 * DNS-rebinding guard for loopback servers: a page on another site can make a browser send
 * requests to 127.0.0.1, but those requests carry the other site's name in the Host header.
 */
export function hostHeaderAllowed(header: string | undefined, allowed: Set<string>): boolean {
  if (header === undefined) return true;
  const match = /^(\[[^\]]+\]|[^:]+)(?::\d{1,5})?$/.exec(header.trim());
  if (!match?.[1]) return false;
  return allowed.has(match[1].toLowerCase().replace(/^\[|\]$/g, ''));
}
