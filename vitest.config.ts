import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: { bindings: {
      TEST_MIGRATIONS: await readD1Migrations('./migrations'),
      TEST_ANALYTICS_MIGRATIONS: await readD1Migrations('./migrations-analytics'),
      TEST_SIGNALS_MIGRATIONS: await readD1Migrations('./migrations-bitcoin-signals'),
      PROXY_ALLOWED_HOSTS: 'api.open-meteo.com',
      // A synthetic placeholder, never a real credential: it lets the daily tests
      // exercise the authenticated CoinGecko path. The missing-key test unsets it.
      COINGECKO_DEMO_API_KEY: 'test-demo-key-not-a-real-secret',
    } },
  })],
  test: { include: ['test/**/*.test.ts'], exclude: ['**/node_modules/**', '**/dist/**', 'test/migration/**'] },
});
