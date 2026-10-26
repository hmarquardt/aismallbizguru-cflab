// Bitcoin Signals is private to the existing operator account. This exception
// does not change CFLab's global administrator or ordinary project semantics.
import type { HumanUser } from '../types';
import { ApiError } from '../http';
import { BITCOIN_SIGNALS } from '../projects';

export function requireSignalsOwner(user: HumanUser | undefined): void {
  if (!user || user.id !== BITCOIN_SIGNALS.ownerUserId || !user.is_admin) {
    throw new ApiError(403, 'forbidden', 'Bitcoin Signals is restricted to its owner');
  }
}
