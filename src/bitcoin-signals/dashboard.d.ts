// Types for the plain-JavaScript dashboard module. The implementation is
// dashboard.js so the Node dashboard tests can import the exact same HTML and
// client script that the Worker serves; this declaration gives the Worker strict
// types without a bundler or a second copy.
export function signalsPage(): string;
export const SIGNALS_SCRIPT: string;
