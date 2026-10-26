// Types for the plain-JavaScript console page module. The implementation is
// page.js so the Node UI tests can import the exact same HTML and client script
// that the Worker serves; this declaration gives the Worker strict types without
// a bundler or a second copy.
export function consolePage(): string;
export const CONSOLE_SCRIPT: string;
