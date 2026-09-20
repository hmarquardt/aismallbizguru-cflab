import { createApp } from './app';
import { requireHumanAdmin } from './auth/human';

// Production administration is a normal human session with is_admin; there is no
// development bypass and no Cloudflare Access dependency in this entrypoint.
// HumanAuthService is a named internal service-binding entrypoint for the
// Analytics Worker; it does not expose an HTTP route.
export { HumanAuthService } from './auth/service';
export default createApp(requireHumanAdmin);
