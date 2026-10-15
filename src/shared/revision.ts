// Deployment identity for release verification.
//
// The release pipeline passes the deployed Git revision as `DEPLOY_REVISION`
// (`wrangler deploy --var DEPLOY_REVISION:<sha>`), so the running revision is
// reported without editing committed configuration for every release. The value
// is non-sensitive release metadata: it is sanitized to a short identifier, and
// no configuration, secret, binding, or environment value is ever included.
//
// Backward compatible: without the variable the route reports `unknown`, and no
// existing route, response shape, or behavior changes.

const REVISION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export interface DeploymentIdentity {
  service: string;
  revision: string;
}

// The environment is accepted as `unknown` so every entrypoint's binding type can
// be passed directly, including types that do not declare this release variable.
export function deploymentIdentity(service: string, env: unknown): DeploymentIdentity {
  const revision = (env as { DEPLOY_REVISION?: unknown } | null | undefined)?.DEPLOY_REVISION;
  return {
    service,
    revision: typeof revision === 'string' && REVISION_PATTERN.test(revision) ? revision : 'unknown',
  };
}
