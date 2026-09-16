// SSRF-safe HTTP(S) client for URLs that come from users, MCP clients or feeds (LBV2-13).
//
// - only http/https (https-only on request)
// - every hop (initial URL and each redirect) is resolved and every resolved
//   address must be public; loopback, private, link-local, CGNAT, ULA,
//   multicast, reserved and IPv4-mapped/embedded forms of those are refused
// - the connection is pinned to the validated address (custom `lookup`), so a
//   second DNS answer cannot rebind the request to an internal host
// - manual redirects (max 5 by default), overall timeout, response size cap
//   applied after decompression
//
// Escape hatch for local single-user setups: MINDBASE_ALLOW_PRIVATE_FETCH=1.
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { isIP } from 'node:net';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import type { Readable } from 'node:stream';

export const ALLOW_PRIVATE_FETCH_ENV = 'MINDBASE_ALLOW_PRIVATE_FETCH';
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
export const DEFAULT_FETCH_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_REDIRECTS = 5;

export type SafeFetchErrorCode = 'bad_url' | 'blocked' | 'too_many_redirects' | 'too_large' | 'timeout' | 'network';

export class SafeFetchError extends Error {
  constructor(readonly code: SafeFetchErrorCode, message: string) {
    super(message);
    this.name = 'SafeFetchError';
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface SafeFetchOptions {
  headers?: Record<string, string>;
  /** Whole request including redirects. Default 15 s. */
  timeoutMs?: number;
  /** Maximum decoded body size. Default 10 MiB. */
  maxBytes?: number;
  /** Default 5. */
  maxRedirects?: number;
  /** Refuse plain http, also on redirects. */
  httpsOnly?: boolean;
  /** Skip the address check. Default: MINDBASE_ALLOW_PRIVATE_FETCH === '1'. */
  allowPrivate?: boolean;
  /** Host names exempt from the address check (configured by code, never by clients). */
  trustedHosts?: readonly string[];
  /** DNS resolver; injectable for tests. Default: system resolver (getaddrinfo). */
  resolve?: Resolver;
  signal?: AbortSignal;
}

export interface SafeFetchResponse {
  status: number;
  statusText: string;
  ok: boolean;
  /** Final URL after redirects. */
  url: string;
  headers: Headers;
  body: Buffer;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type AddressClass =
  | 'public' | 'invalid' | 'unspecified' | 'loopback' | 'private' | 'cgnat' | 'link-local'
  | 'unique-local' | 'multicast' | 'reserved';

// ── Address classification ────────────────────────────────────────────────

function parseIPv4(s: string): number[] | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function parseIPv6(input: string): number[] | null {
  const s = input.replace(/%.*$/, '');
  if (!s.includes(':')) return null;
  let head = s;
  let v4: number[] | null = null;
  const lastColon = s.lastIndexOf(':');
  if (s.slice(lastColon + 1).includes('.')) {
    v4 = parseIPv4(s.slice(lastColon + 1));
    if (!v4) return null;
    head = s.slice(0, lastColon + 1) + '0:0';
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };
  const left = toGroups(halves[0] ?? '');
  const right = halves.length === 2 ? toGroups(halves[1] ?? '') : [];
  if (!left || !right) return null;
  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    groups = [...left, ...new Array<number>(missing).fill(0), ...right];
  } else {
    groups = left;
  }
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) bytes.push(g >> 8, g & 0xff);
  if (v4) bytes.splice(12, 4, ...v4);
  return bytes;
}

function classifyIPv4(b: number[]): AddressClass {
  const [a = 0, c = 0, d = 0] = b;
  if (a === 0) return 'unspecified';
  if (a === 10) return 'private';
  if (a === 100 && c >= 64 && c <= 127) return 'cgnat';
  if (a === 127) return 'loopback';
  if (a === 169 && c === 254) return 'link-local';
  if (a === 172 && c >= 16 && c <= 31) return 'private';
  if (a === 192 && c === 0 && d === 0) return 'reserved';
  if (a === 192 && c === 168) return 'private';
  if (a === 198 && (c === 18 || c === 19)) return 'reserved';
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved';
  return 'public';
}

function classifyIPv6(b: number[]): AddressClass {
  const zeroPrefix = (n: number) => b.slice(0, n).every((x) => x === 0);
  // ::/96 — unspecified, loopback and deprecated IPv4-compatible addresses
  if (zeroPrefix(12)) {
    const last = b.slice(12);
    if (last.every((x) => x === 0)) return 'unspecified';
    if (last[0] === 0 && last[1] === 0 && last[2] === 0 && last[3] === 1) return 'loopback';
    return 'reserved';
  }
  // ::ffff:0:0/96 — IPv4-mapped
  if (zeroPrefix(10) && b[10] === 0xff && b[11] === 0xff) return classifyIPv4(b.slice(12));
  // 64:ff9b::/96 — NAT64 well-known prefix embeds IPv4
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) {
    return classifyIPv4(b.slice(12));
  }
  // 2002::/16 — 6to4 embeds IPv4 in bytes 2..5
  if (b[0] === 0x20 && b[1] === 0x02) return classifyIPv4(b.slice(2, 6));
  const first = b[0] ?? 0;
  const second = b[1] ?? 0;
  if (first === 0x01 && second === 0x00 && b.slice(2, 8).every((x) => x === 0)) return 'reserved'; // 100::/64 discard
  if ((first & 0xfe) === 0xfc) return 'unique-local'; // fc00::/7
  if (first === 0xfe && (second & 0xc0) === 0x80) return 'link-local'; // fe80::/10
  if (first === 0xfe && (second & 0xc0) === 0xc0) return 'reserved'; // fec0::/10 site-local
  if (first === 0xff) return 'multicast';
  return 'public';
}

/** Classifies an IP literal. Anything that is not a strict dotted-quad or IPv6 literal is `invalid`. */
export function classifyAddress(ip: string): AddressClass {
  const v4 = parseIPv4(ip);
  if (v4) return classifyIPv4(v4);
  const v6 = parseIPv6(ip);
  if (v6) return classifyIPv6(v6);
  return 'invalid';
}

export function isPublicAddress(ip: string): boolean {
  return classifyAddress(ip) === 'public';
}

// ── Fetch ─────────────────────────────────────────────────────────────────

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const systemResolve: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 })));
    });
  });

function parseTarget(raw: string | URL, httpsOnly: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError('bad_url', 'Blocked URL: not a valid absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SafeFetchError('bad_url', `Blocked URL: scheme ${url.protocol} is not allowed (http/https only)`);
  }
  if (httpsOnly && url.protocol !== 'https:') {
    throw new SafeFetchError('bad_url', 'Blocked URL: only https is allowed');
  }
  return url;
}

async function resolveTarget(url: URL, opts: SafeFetchOptions): Promise<ResolvedAddress> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(host);
  let addresses: ResolvedAddress[];
  if (family !== 0) {
    addresses = [{ address: host, family: family === 6 ? 6 : 4 }];
  } else {
    try {
      addresses = await (opts.resolve ?? systemResolve)(host);
    } catch {
      throw new SafeFetchError('network', `Could not resolve host ${host}`);
    }
    if (addresses.length === 0) throw new SafeFetchError('network', `Could not resolve host ${host}`);
  }
  const allowPrivate = opts.allowPrivate ?? process.env[ALLOW_PRIVATE_FETCH_ENV] === '1';
  const trusted = (opts.trustedHosts ?? []).some((h) => h.toLowerCase() === host.toLowerCase());
  if (!allowPrivate && !trusted && addresses.some((a) => !isPublicAddress(a.address))) {
    // Deliberately no address in the message: it would turn the error into a DNS oracle.
    throw new SafeFetchError(
      'blocked',
      `Blocked URL: ${host} is a private, loopback, link-local or reserved address (set ${ALLOW_PRIVATE_FETCH_ENV}=1 to allow on local setups)`,
    );
  }
  return addresses[0] as ResolvedAddress;
}

interface Hop {
  status: number;
  statusText: string;
  message: IncomingMessage;
}

function openHop(url: URL, pinned: ResolvedAddress, headers: Record<string, string>, signal: AbortSignal): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const lookup = (
      _hostname: string,
      options: LookupOptions,
      callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
    ): void => {
      if (options.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
      else callback(null, pinned.address, pinned.family);
    };
    const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = requestFn(
      url,
      { method: 'GET', headers, lookup, signal, agent: false },
      (message) => resolve({ status: message.statusCode ?? 0, statusText: message.statusMessage ?? '', message }),
    );
    req.on('error', reject);
    req.end();
  });
}

function decoded(message: IncomingMessage): Readable {
  const encoding = (message.headers['content-encoding'] ?? '').trim().toLowerCase();
  if (encoding === 'gzip' || encoding === 'x-gzip') return message.pipe(createGunzip());
  if (encoding === 'deflate') return message.pipe(createInflate());
  if (encoding === 'br') return message.pipe(createBrotliDecompress());
  return message;
}

async function readBody(message: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(message.headers['content-length']);
  if (!message.headers['content-encoding'] && Number.isFinite(declared) && declared > maxBytes) {
    message.destroy();
    throw new SafeFetchError('too_large', `Response exceeds the limit of ${maxBytes} bytes`);
  }
  const stream = decoded(message);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > maxBytes) throw new SafeFetchError('too_large', `Response exceeds the limit of ${maxBytes} bytes`);
      chunks.push(buf);
    }
  } finally {
    if (total > maxBytes) {
      stream.destroy();
      message.destroy();
    }
  }
  return Buffer.concat(chunks);
}

function toHeaders(message: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined || name === 'content-encoding' || name === 'content-length') continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  return headers;
}

/** GET a user-supplied URL with SSRF protection. Throws SafeFetchError for policy, size and timeout failures. */
export async function safeFetch(input: string | URL, opts: SafeFetchOptions = {}): Promise<SafeFetchResponse> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_FETCH_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const httpsOnly = opts.httpsOnly ?? false;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onOuterAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
  if (opts.signal?.aborted) controller.abort();

  let headers: Record<string, string> = { 'accept-encoding': 'gzip, deflate, br', ...opts.headers };
  let url = parseTarget(input, httpsOnly);
  try {
    for (let redirects = 0; ; redirects++) {
      const pinned = await resolveTarget(url, opts);
      if (controller.signal.aborted) throw new Error('aborted');
      const hop = await openHop(url, pinned, headers, controller.signal);
      const location = hop.message.headers.location;
      if (REDIRECT_STATUSES.has(hop.status) && location) {
        hop.message.resume();
        if (redirects >= maxRedirects) {
          throw new SafeFetchError('too_many_redirects', `Too many redirects (limit ${maxRedirects})`);
        }
        const next = parseTarget(new URL(location, url), httpsOnly);
        if (next.origin !== url.origin) {
          headers = Object.fromEntries(
            Object.entries(headers).filter(([k]) => !['authorization', 'cookie'].includes(k.toLowerCase())),
          );
        }
        url = next;
        continue;
      }
      const body = await readBody(hop.message, maxBytes);
      return {
        status: hop.status,
        statusText: hop.statusText,
        ok: hop.status >= 200 && hop.status < 300,
        url: url.href,
        headers: toHeaders(hop.message),
        body,
        text: async () => body.toString('utf-8'),
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      };
    }
  } catch (e) {
    if (timedOut) throw new SafeFetchError('timeout', `Request timed out after ${timeoutMs} ms`);
    if (e instanceof SafeFetchError) throw e;
    if (controller.signal.aborted) throw new SafeFetchError('network', 'Request aborted');
    throw new SafeFetchError('network', `Request failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }
}
