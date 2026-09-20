import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Bindings } from '../types';
import { HUMAN_TOKEN_PATTERN, sessionUser } from './human';

export interface VerifiedHuman {
  userId: string;
  isAdmin: boolean;
}

// Narrow internal RPC surface used by the Analytics Worker service binding.
// Returns only the identity analytics authorization needs: no email, profile,
// password material, or session internals. Invalid sessions return null.
export class HumanAuthService extends WorkerEntrypoint<Bindings> {
  async verifyHumanSession(token: string): Promise<VerifiedHuman | null> {
    if (typeof token !== 'string' || token.length > 128 || !HUMAN_TOKEN_PATTERN.test(token)) return null;
    try {
      const user = await sessionUser(this.env, token);
      return { userId: user.id, isAdmin: user.is_admin };
    } catch {
      return null;
    }
  }
}
