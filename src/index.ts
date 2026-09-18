import { createApp } from './app';
import { requireHumanAdmin } from './auth/human';

// Production administration is a normal human session with is_admin; there is no
// development bypass and no Cloudflare Access dependency in this entrypoint.
export default createApp(requireHumanAdmin);
