import { resolve4, resolve6 } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ApiError } from '../http';

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  // Conservatively accept global unicast only, excluding special/transition space.
  return isIP(address) === 6 && /^[23]/i.test(address) && !/^200[12]:/i.test(address)
    && !/^3fff:/i.test(address);
}
export async function assertPublicDns(host: string): Promise<void> {
  const answers = await Promise.all([resolve4(host), resolve6(host)].map(async promise => {
    try { return await promise; }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENODATA') return [];
      throw new ApiError(502, 'upstream_dns', 'Upstream DNS resolution failed');
    }
  }));
  const addresses = answers.flat();
  if (!addresses.length || addresses.some(address => !publicAddress(address))) {
    throw new ApiError(502, 'unsafe_upstream', 'Upstream did not resolve exclusively to public addresses');
  }
}
