#!/usr/bin/env node
// `npm run deploy` deliberately does not deploy.
//
// The natural command a person or agent reaches for must state the policy rather
// than publish something unreviewed. A release has to be a commit that passed CI
// on GitHub, and this command cannot know whether the checkout is clean, pushed,
// or validated — so it refuses and explains, instead of guessing.
//
// This is not a deployment path: nothing here contacts Cloudflare. The emergency
// procedure lives in docs/CI-CD.md#emergency-manual-deployment and is documented
// for operators who have confirmed the pipeline itself is blocked.

const message = `
Production releases are published by GitHub Actions, not from a developer machine.

  push to main  ->  validate  ->  (CLOUDFLARE_DEPLOY_ENABLED=true)  ->  deploy  ->  verify

\`npm run deploy\` refuses on purpose. A release must be a reviewed commit that
passed CI, and this command cannot verify that the checkout is clean, pushed, and
validated. See AGENTS.md (release policy) and docs/CI-CD.md (runbook).

  Validate locally:   npm run check && npm run build && npm run build:analytics
  Release:            merge to main; the pipeline publishes and verifies both Workers
  Check production:   node scripts/verify-production.mjs --service all
  Check for drift:    node scripts/verify-drift.mjs
  Emergency only:     docs/CI-CD.md#emergency-manual-deployment
`;

console.error(message.trim());
process.exitCode = 1;
