// Input validation and derivation for the collector. Everything here is pure:
// invalid values come back as null so callers decide the response code.

export const MAX_CANONICAL_BODY_BYTES = 8 * 1024;
export const MAX_LEGACY_BODY_BYTES = 32 * 1024;
export const MAX_PROPS = 10;
export const MAX_PROP_KEY_LENGTH = 40;
export const MAX_PROP_STRING_LENGTH = 200;
export const MAX_PROPS_JSON_BYTES = 2 * 1024;
export const MAX_EVENT_NAMES_PER_SITE = 100;

const TOKEN_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]{0,39}$/;
const SESSION_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const EVENT_UID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HOSTNAME_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const COUNTRY_PATTERN = /^[A-Z0-9]{2}$/;
const REGION_PATTERN = /^[A-Z0-9-]{1,8}$/;
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || CONTROL_PATTERN.test(trimmed)) return null;
  return trimmed;
}

export function optionalText(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  return cleanText(value, max);
}

export function optionalNumber(value: unknown, min: number, max: number): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

export function validEventName(value: unknown): string | null {
  const text = cleanText(value, MAX_PROP_KEY_LENGTH);
  return text && TOKEN_PATTERN.test(text) ? text : null;
}

export function validSlug(value: unknown): string | null {
  const text = cleanText(value, 64);
  return text && SLUG_PATTERN.test(text) ? text : null;
}

export function validSessionId(value: unknown): string | null {
  const text = cleanText(value, 64);
  return text && SESSION_PATTERN.test(text) ? text : null;
}

export function validEventUid(value: unknown): string | null {
  const text = cleanText(value, 64);
  return text && EVENT_UID_PATTERN.test(text) ? text : null;
}

// Paths keep the pathname only: query strings and fragments are never stored.
export function normalizePathname(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cut = value.split(/[?#]/, 1)[0] ?? '';
  const path = cut.trim();
  if (!path.startsWith('/') || path.length > 1024 || CONTROL_PATTERN.test(path)) return null;
  return path;
}

export function normalizeHostname(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let host = value.trim().toLowerCase();
  if (!host || host.length > 253) return null;
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  const slash = host.search(/[/?#]/);
  if (slash >= 0) host = host.slice(0, slash);
  const colon = host.lastIndexOf(':');
  if (colon > 0 && /^\d{1,5}$/.test(host.slice(colon + 1))) host = host.slice(0, colon);
  if (!host || !HOSTNAME_PATTERN.test(host)) return null;
  return host;
}

// Full external referrer URLs are reduced to a hostname at collection time.
export function referrerHost(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const host = new URL(value.trim()).hostname.toLowerCase().replace(/^www\./, '');
    return HOSTNAME_PATTERN.test(host) ? host.slice(0, 256) : null;
  } catch {
    return null;
  }
}

export function requestHostname(request: Request): string | null {
  const origin = request.headers.get('Origin');
  if (origin) return normalizeHostname(origin);
  return null;
}

export type PropsResult = { ok: true; json: string | null } | { ok: false; reason: string };

// Constrained shallow JSON: strings, finite numbers, booleans only.
export function sanitizeProps(value: unknown): PropsResult {
  if (value === undefined || value === null) return { ok: true, json: null };
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'props_not_object' };
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_PROPS) return { ok: false, reason: 'props_too_many' };
  const output: Record<string, string | number | boolean> = {};
  for (const [key, raw] of entries) {
    if (key.length > MAX_PROP_KEY_LENGTH || !TOKEN_PATTERN.test(key)) return { ok: false, reason: 'props_key_invalid' };
    if (typeof raw === 'string') {
      const text = raw.trim();
      if (text.length > MAX_PROP_STRING_LENGTH || CONTROL_PATTERN.test(text)) return { ok: false, reason: 'props_value_invalid' };
      output[key] = text;
    } else if (typeof raw === 'number') {
      if (!Number.isFinite(raw)) return { ok: false, reason: 'props_value_invalid' };
      output[key] = raw;
    } else if (typeof raw === 'boolean') {
      output[key] = raw;
    } else {
      return { ok: false, reason: 'props_value_invalid' };
    }
  }
  const json = JSON.stringify(output);
  if (new TextEncoder().encode(json).byteLength > MAX_PROPS_JSON_BYTES) return { ok: false, reason: 'props_too_large' };
  return { ok: true, json };
}

export interface ParsedAgent {
  browser: string | null;
  os: string | null;
  device: string | null;
}

// Only derived families are stored; the raw User-Agent is discarded.
export function parseUserAgent(userAgent: string | null | undefined): ParsedAgent {
  if (!userAgent) return { browser: null, os: null, device: null };
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /OPR\//.test(userAgent) ? 'Opera' : /Chrome\//.test(userAgent) ? 'Chrome'
    : /Firefox\//.test(userAgent) ? 'Firefox' : /Safari\//.test(userAgent) ? 'Safari' : 'Other';
  const os = /Windows/.test(userAgent) ? 'Windows' : /Android/.test(userAgent) ? 'Android' : /iPhone|iPad|iOS/.test(userAgent) ? 'iOS'
    : /Mac OS X/.test(userAgent) ? 'macOS' : /Linux/.test(userAgent) ? 'Linux' : 'Other';
  const device = /iPad|Tablet/.test(userAgent) ? 'tablet' : /Mobi|Android|iPhone/.test(userAgent) ? 'mobile' : 'desktop';
  return { browser, os, device };
}

export function isBot(userAgent: string | null | undefined): boolean {
  return !!userAgent && /bot|crawler|spider|preview|headless/i.test(userAgent);
}

export function validTimezone(value: unknown): string | null {
  const text = cleanText(value, 64);
  if (!text) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: text });
    return text;
  } catch {
    return null;
  }
}

// Calendar date in the Site's configured timezone.
export function siteDay(timeZone: string, epochMs: number): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(epochMs));
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function shiftDay(day: string, delta: number): string {
  const [year, month, date] = day.split('-').map(Number);
  const shifted = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, date ?? 1));
  shifted.setUTCDate(shifted.getUTCDate() + delta);
  return shifted.toISOString().slice(0, 10);
}

export function validDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

export function countryCode(value: string | null): string | null {
  if (!value) return null;
  const upper = value.trim().toUpperCase();
  return COUNTRY_PATTERN.test(upper) ? upper : null;
}

export function regionCode(value: string | null): string | null {
  if (!value) return null;
  const upper = value.trim().toUpperCase();
  return REGION_PATTERN.test(upper) ? upper : null;
}

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export function newPublicId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(22));
  let id = '';
  for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
  return `as_${id}`;
}

export function slugFromName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/g, '');
  return slug || 'site';
}
