import { createApp } from './app';
import { ApiError } from './http';

// Access seam: replace only after validating Access JWT signature, issuer,
// audience, expiry, and the intended admin policy. Headers alone are not auth.
export default createApp(async () => {
  throw new ApiError(403, 'admin_disabled', 'Administration is disabled on this entrypoint');
});
