/**
 * Web addresses in storyboard text. Text from a pull request description could otherwise point
 * reviewers at a site of its choice, so an address may only appear when its host is in the code
 * change itself (explaining which endpoint the code calls is part of explaining the code) or in the
 * caller's task and notes. Addresses on this machine, on a private network or on reserved example
 * hosts are always fine.
 */
import { fileExtensions } from '../core/languages.ts';
import { isPrivateHostname } from '../core/net.ts';
import { isShowable } from '../core/path-policy.ts';
import type { ChangedFile } from '../core/types.ts';

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
/**
 * A "scheme://" address, a "www." address, or a bare host: names of letters, digits and hyphens
 * joined by dots, ending in 2 to 24 letters ("evil.com", "attacker.top/login"). A host must stand
 * alone: "req.app.get()" is a name in code, not an address.
 */
const ADDRESS =
  /(?<![\w.@/-])(?:(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"')\]]+|(?:[a-z0-9-]+\.)+[a-z]{2,24}(?![\w(@-]|\.\w)(?:[/:?#][^\s<>"')\]]*)?)/gi;
/** The last part of a bare name is a file or configuration extension, not a top-level domain. */
const NOT_A_TLD = new Set([
  // ".ru" is also a rackup file, but far more often a country domain.
  ...fileExtensions().filter((extension) => extension !== 'ru'),
  ...'json yml yaml toml lock md txt mod sum gradle xml ini cfg conf env properties csv svg png jpg jpeg gif webp pdf zip gz wasm map'.split(
    ' ',
  ),
]);
/**
 * Extensions that are also top-level domains. "deploy.sh" stays a file name, but with a path after it
 * ("attacker.sh/login") the name is an address.
 */
const DOMAIN_LIKE_EXTENSIONS = new Set('cc cr md mk ml mm pl pm py rs sc sh tf fish zip'.split(' '));
/** Product names that contain a dot. */
const PRODUCT_NAMES = new Set(['asp.net', 'vb.net', 'ado.net', 'socket.io']);
const RESERVED = /(?:^|\.)example\.(?:com|org|net)$|\.(?:test|invalid|example|localhost)$/i;

function addressHostname(address: string): string | null {
  // A bare name is read as it is, so "retry.ts:42" is the name retry.ts with a line, not a bad port.
  if (!SCHEME.test(address)) return address.split(/[/:?#]/, 1)[0]?.toLowerCase() || null;
  try {
    return new URL(address).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Host names of every web address in the text. */
export function hostsIn(text: string): string[] {
  return (text.match(ADDRESS) ?? []).map(addressHostname).filter((host): host is string => host !== null);
}

/**
 * Addresses in the text that point somewhere other than this machine, a private network, an example
 * host, or a host in `allowedHosts` (hosts that appear in the code change). A bare name is also
 * fine when it is a file name, a product name, or appears anywhere in `codeText` (the code and file
 * paths of the change, lower case): "logger.info" is a name in code, not an address.
 */
export function foreignUrls(
  text: string,
  allowedHosts: ReadonlySet<string> = new Set(),
  codeText = '',
): string[] {
  return (text.match(ADDRESS) ?? []).filter((address) => {
    const host = addressHostname(address);
    if (!host) return true;
    if (isPrivateHostname(host) || RESERVED.test(host) || allowedHosts.has(host)) return false;
    if (SCHEME.test(address) || host.startsWith('www.')) return true;
    const ending = host.slice(host.lastIndexOf('.') + 1);
    const fileName = NOT_A_TLD.has(ending) && !(DOMAIN_LIKE_EXTENSIONS.has(ending) && /\/./.test(address));
    return !(fileName || PRODUCT_NAMES.has(host) || codeText.includes(host));
  });
}

/**
 * The code lines and paths of the visible files, plus any names the analysis read from the code, in
 * lower case, for the `codeText` argument of `foreignUrls`.
 */
export function codeTextOf(files: readonly ChangedFile[], names: readonly string[] = []): string {
  const parts: string[] = [...names];
  for (const file of files) {
    if (!isShowable(file)) continue;
    parts.push(file.path);
    for (const hunk of file.hunks) for (const line of hunk.lines) parts.push(line.text);
  }
  return parts.join('\n').toLowerCase();
}
