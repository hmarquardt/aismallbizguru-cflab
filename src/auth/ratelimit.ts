import type { Bindings } from '../types';
import { ApiError } from '../http';
import { hashToken } from './crypto';

// Keys never contain raw emails or tokens: route + SHA-256(value).
export async function rateLimitKey(route: string, value: string): Promise<string> {
  return `${route}:${await hashToken(value)}`;
}
export async function enforceRateLimit(binding: Bindings['RL_LOGIN'], key: string): Promise<void> {
  if (!binding) return;
  const { success } = await binding.limit({ key });
  if (!success) throw new ApiError(429, 'rate_limited', 'Too many requests; try again later');
}
