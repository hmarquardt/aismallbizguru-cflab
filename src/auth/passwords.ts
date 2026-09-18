import { scryptSync } from 'node:crypto';
import { timingSafeEqual } from './crypto';
import { invalid } from '../http';

// Password representation: scrypt$<N>$<r>$<p>$<base64 salt>$<base64 derived key>.
// Parameters are stored with the hash so they can be raised later without breaking old rows.
// Workers enforces a 100,000-iteration PBKDF2 ceiling, so CFLab uses OWASP's recommended
// scrypt fallback (N=2^13, r=8, p=10) through the native node:crypto binding.
export const SCRYPT_N = 8192;
export const SCRYPT_R = 8;
export const SCRYPT_P = 10;
// 128 * N * r needs 8 MiB; 32 MiB leaves headroom below the 128 MiB isolate ceiling.
export const SCRYPT_MAXMEM = 32 * 1024 * 1024;
export const PASSWORD_MIN_LENGTH = 15;
export const PASSWORD_MAX_LENGTH = 128;
const ALGORITHM = 'scrypt';
const SALT_BYTES = 16;
const KEY_BYTES = 32;

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function fromBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch { return null; }
}
function derive(password: string, salt: Uint8Array, n: number, r: number, p: number): Uint8Array {
  return new Uint8Array(scryptSync(password, salt, KEY_BYTES, { N: n, r, p, maxmem: SCRYPT_MAXMEM }));
}
function parse(stored: string | null | undefined) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== ALGORITHM) return null;
  const n = Number(parts[1]); const r = Number(parts[2]); const p = Number(parts[3]);
  if (!Number.isInteger(n) || n < 1024 || n > 1_048_576 || (n & (n - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1 || r > 32) return null;
  if (!Number.isInteger(p) || p < 1 || p > 16) return null;
  const salt = fromBase64(parts[4]!);
  const key = fromBase64(parts[5]!);
  if (!salt || salt.length < SALT_BYTES || !key || key.length !== KEY_BYTES) return null;
  // Never let a stored row force memory above the configured budget.
  if (128 * n * r > SCRYPT_MAXMEM) return null;
  return { n, r, p, salt, key };
}

// Policy is deliberately length-only: Unicode, spaces, and manager-generated strings all pass.
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string') return 'Password must be a string';
  const length = Array.from(password).length;
  if (length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  return null;
}
export function assertPassword(password: unknown): string {
  const problem = passwordProblem(password);
  if (problem) invalid(problem);
  return password as string;
}
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key = derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `${ALGORITHM}$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${base64(salt)}$${base64(key)}`;
}
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;
  const key = derive(password, parsed.salt, parsed.n, parsed.r, parsed.p);
  return timingSafeEqual(key, parsed.key);
}
// Used to spend comparable work when the account does not exist or has no password.
let dummy: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummy ??= hashPassword('cflab-timing-equalization-placeholder');
  return dummy;
}
