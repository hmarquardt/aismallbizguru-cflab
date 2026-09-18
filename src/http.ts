import type { ContentfulStatusCode } from 'hono/utils/http-status';

export class ApiError extends Error {
  constructor(public status: ContentfulStatusCode, public code: string, message: string) { super(message); }
}
export function invalid(message: string): never { throw new ApiError(400, 'invalid_input', message); }
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected a JSON object');
  return value as Record<string, unknown>;
}
export function fields(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(k => !allowed.includes(k))) invalid('Unknown field');
}
export function string(value: unknown, name: string, max = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) invalid(`Invalid ${name}`);
  return value;
}
export function slug(value: unknown): string {
  const result = string(value, 'slug', 64);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(result)) invalid('Invalid slug');
  return result;
}
export function id(value: unknown): string {
  const result = string(value, 'id', 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result)) invalid('Invalid id');
  return result;
}
export function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid('Expected a boolean');
  return value;
}
export function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) invalid(`Expected integer ${min}–${max}`);
  return value;
}
export function strings(value: unknown, max = 32): string[] {
  if (!Array.isArray(value) || value.length > max) invalid('Invalid list');
  return [...new Set(value.map(v => string(v, 'list item', 256)))];
}
export async function readLimited(stream: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > max) { await reader.cancel(); throw new ApiError(413, 'body_too_large', 'Body exceeds size limit'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    throw new ApiError(415, 'unsupported_media_type', 'Expected application/json');
  }
  const bytes = await readLimited(request.body, 64 * 1024);
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { invalid('Malformed JSON'); }
  return object(value);
}
export function page(url: string, extra: string[] = []) {
  const query = new URL(url).searchParams;
  for (const key of query.keys()) {
    if (!['limit', 'after', ...extra].includes(key) || query.getAll(key).length !== 1) invalid('Unknown or repeated query parameter');
  }
  const raw = query.get('limit') ?? '50';
  if (!/^\d{1,3}$/.test(raw)) invalid('Invalid limit');
  const limit = integer(Number(raw), 1, 100);
  const after = query.get('after');
  return { limit, after: after ? id(after) : '', query };
}
