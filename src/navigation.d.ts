// Types for the plain-JavaScript navigation policy module. The implementation is
// navigation.js so the Node UI tests and the Worker share one copy.
export function safeReturnPath(value: unknown): string | null;
export function loginDestination(user: { is_admin?: boolean } | null | undefined, search: unknown): string;
export const CLIENT_NAVIGATION_JS: string;
