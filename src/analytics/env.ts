import type { RateLimitBinding } from '../types';

export type SiteRole = 'owner' | 'editor' | 'viewer';

export interface VerifiedHuman {
  userId: string;
  isAdmin: boolean;
}

// Narrow service-binding surface exposed by CFLab's HumanAuthService.
export interface CflabAuthBinding {
  verifyHumanSession(token: string): Promise<VerifiedHuman | null>;
}

export interface AnalyticsBindings {
  ANALYTICS: D1Database;
  CFLAB?: CflabAuthBinding;
  RL_ANALYTICS?: RateLimitBinding;
}

export type AnalyticsEnv = {
  Bindings: AnalyticsBindings;
  Variables: {
    identity: VerifiedHuman;
    site: import('./sites').SiteRow;
    role: SiteRole;
  };
};
