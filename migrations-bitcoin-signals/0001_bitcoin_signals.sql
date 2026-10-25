-- Bitcoin Signals: market data, evidence, research hypotheses, alerts, and
-- collection history live in their own D1 database (`cflab-bitcoin-signals`,
-- binding BTC_SIGNALS). Identity, permissions, and the project registry stay in
-- the primary `cflab` database; nothing here references a user or app row.
--
-- Additive only. Every statement is CREATE TABLE / CREATE INDEX / INSERT OR
-- IGNORE so the release gate can classify the migration as safe without an
-- operator approval. Observations are append-only: a correction is a new row
-- with a higher `revision`, never an in-place edit.

CREATE TABLE bs_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  homepage TEXT NOT NULL,
  cadence TEXT NOT NULL CHECK (cadence IN ('hourly', 'daily', 'curated')),
  default_tier TEXT NOT NULL CHECK (default_tier IN ('measured', 'reported', 'estimated', 'curated')),
  definition TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE bs_collection_runs (
  id TEXT PRIMARY KEY,
  job TEXT NOT NULL CHECK (job IN ('hourly', 'daily', 'manual')),
  trigger TEXT NOT NULL CHECK (trigger IN ('cron', 'manual')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'ok', 'partial', 'failed', 'skipped')),
  detail TEXT,
  sources_total INTEGER NOT NULL DEFAULT 0,
  sources_ok INTEGER NOT NULL DEFAULT 0,
  sources_failed INTEGER NOT NULL DEFAULT 0,
  observations_seen INTEGER NOT NULL DEFAULT 0,
  observations_added INTEGER NOT NULL DEFAULT 0,
  requested_by_user_id TEXT
);
CREATE INDEX bs_runs_by_started ON bs_collection_runs(started_at);
CREATE INDEX bs_runs_by_job ON bs_collection_runs(job, started_at);

CREATE TABLE bs_source_runs (
  run_id TEXT NOT NULL REFERENCES bs_collection_runs(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES bs_sources(id),
  status TEXT NOT NULL CHECK (status IN ('ok', 'failed', 'empty')),
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  observations_seen INTEGER NOT NULL DEFAULT 0,
  observations_added INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  PRIMARY KEY (run_id, source_id)
);
CREATE INDEX bs_source_runs_by_source ON bs_source_runs(source_id, started_at);

-- One row per measurement. The unique key makes collection idempotent: a repeat
-- of the same source/series/venue/time observation is a no-op, while a
-- correction is stored as revision+1 next to the original.
CREATE TABLE bs_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES bs_sources(id),
  source_url TEXT NOT NULL,
  series TEXT NOT NULL,
  venue TEXT NOT NULL DEFAULT 'global',
  observed_at TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT NOT NULL,
  definition TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('measured', 'reported', 'estimated', 'curated')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  run_id TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json)),
  UNIQUE (source_id, series, venue, observed_at, revision)
);
CREATE INDEX bs_observations_by_series ON bs_observations(series, venue, observed_at);
CREATE INDEX bs_observations_by_source ON bs_observations(source_id, observed_at);

CREATE TABLE bs_hypotheses (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Source-backed timeline. `status` separates a proposal from an effective rule
-- or a documented economic activity, and `review_status` records whether a human
-- confirmed the entry against the cited source.
CREATE TABLE bs_evidence (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('treasury', 'retention', 'lightning', 'settlement', 'regulation', 'market', 'contradiction')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  jurisdiction TEXT,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'authorized', 'pilot', 'effective', 'activity', 'market')),
  direction TEXT NOT NULL CHECK (direction IN ('supports', 'contradicts', 'mixed')),
  importance TEXT NOT NULL CHECK (importance IN ('low', 'normal', 'high')),
  source_title TEXT NOT NULL,
  source_url TEXT NOT NULL,
  published_at TEXT,
  retrieved_at TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed', 'verified', 'rejected')),
  reviewed_by_user_id TEXT,
  reviewed_at TEXT,
  fingerprint TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX bs_evidence_by_occurred ON bs_evidence(occurred_at);
CREATE INDEX bs_evidence_by_review ON bs_evidence(review_status, occurred_at);
CREATE INDEX bs_evidence_by_kind ON bs_evidence(kind, occurred_at);

CREATE TABLE bs_evidence_hypotheses (
  evidence_id TEXT NOT NULL REFERENCES bs_evidence(id) ON DELETE CASCADE,
  hypothesis_id TEXT NOT NULL REFERENCES bs_hypotheses(id) ON DELETE CASCADE,
  effect TEXT NOT NULL CHECK (effect IN ('supports', 'contradicts', 'mixed')),
  PRIMARY KEY (evidence_id, hypothesis_id)
);
CREATE INDEX bs_evidence_hypotheses_by_hypothesis ON bs_evidence_hypotheses(hypothesis_id);

CREATE TABLE bs_alerts (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL CHECK (rule_id IN ('funding-sustained', 'treasury-change', 'verified-development', 'stale-source')),
  dedupe_key TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  observed_value REAL,
  threshold REAL,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT,
  acknowledged_by_user_id TEXT,
  UNIQUE (rule_id, dedupe_key)
);
CREATE INDEX bs_alerts_by_created ON bs_alerts(created_at);

CREATE TABLE bs_alert_deliveries (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES bs_alerts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('email')),
  recipient TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  attempted_at TEXT NOT NULL,
  error_code TEXT
);
CREATE INDEX bs_alert_deliveries_by_alert ON bs_alert_deliveries(alert_id, attempted_at);

-- Operator configuration. Notifications are OFF until explicitly enabled here.
CREATE TABLE bs_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at TEXT NOT NULL,
  updated_by_user_id TEXT
);

-- Attested backup verification. Recorded from the read-only backup-status
-- report; the Worker never claims a backup exists without this evidence.
CREATE TABLE bs_backup_checks (
  id TEXT PRIMARY KEY,
  checked_at TEXT NOT NULL,
  source TEXT NOT NULL,
  max_age_hours REAL NOT NULL,
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  report_json TEXT NOT NULL CHECK (json_valid(report_json)),
  recorded_at TEXT NOT NULL,
  recorded_by_user_id TEXT NOT NULL
);
CREATE INDEX bs_backup_checks_by_checked ON bs_backup_checks(checked_at);

-- Single-row-per-job lease. Acquisition is one atomic upsert, so two overlapping
-- cron invocations cannot both collect.
CREATE TABLE bs_collection_locks (
  job TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);


INSERT OR IGNORE INTO bs_sources (id, name, homepage, cadence, default_tier, definition, active, created_at) VALUES
  ('okx', 'OKX public market data', 'https://www.okx.com/docs-v5/en/', 'hourly', 'measured', 'Funding rate, mark price and index price for BTC-USDT-SWAP and the spot BTC-USDT last price, as published by OKX.', 1, '2026-10-25T00:00:00.000Z'),
  ('deribit', 'Deribit public market data', 'https://docs.deribit.com/', 'hourly', 'measured', 'Perpetual funding, index price and dated-future mark price for BTC instruments, as published by Deribit.', 0, '2026-10-25T00:00:00.000Z'),
  ('kraken-futures', 'Kraken Futures public market data', 'https://docs.kraken.com/api/docs/futures-api/', 'hourly', 'measured', 'Relative funding rate for the PF_XBTUSD perpetual and mark/index price for dated XBT futures, as published by Kraken Futures.', 1, '2026-10-25T00:00:00.000Z'),
  ('kraken-spot', 'Kraken spot public market data', 'https://docs.kraken.com/api/docs/rest-api/', 'hourly', 'measured', 'Last trade price for the XBTUSD spot pair, as published by Kraken.', 1, '2026-10-25T00:00:00.000Z'),
  ('coinbase-spot', 'Coinbase Exchange public market data', 'https://docs.cdp.coinbase.com/exchange/rest-api/', 'hourly', 'measured', 'Last trade price for the BTC-USD spot pair, as published by Coinbase Exchange.', 1, '2026-10-25T00:00:00.000Z'),
  ('mempool-space', 'mempool.space Lightning statistics', 'https://mempool.space/docs/api/rest', 'hourly', 'reported', 'Public Lightning Network node count, channel count and total public channel capacity, as aggregated by mempool.space. Capacity and channels are not payment volume.', 1, '2026-10-25T00:00:00.000Z'),
  ('coingecko-treasury', 'CoinGecko public treasury dataset', 'https://www.coingecko.com/en/api', 'daily', 'reported', 'Public-company bitcoin holdings aggregated by CoinGecko from public disclosures. A report about filings and announcements, not an audit performed by CFLab.', 1, '2026-10-25T00:00:00.000Z'),
  ('curated-research', 'Curated attributed research', 'https://cflab.aismallbizguru.com/bitcoin-signals', 'curated', 'curated', 'Human-curated evidence entered by an administrator from an attributed public source. Never machine-measured and never presented as a live measurement.', 1, '2026-10-25T00:00:00.000Z');

INSERT OR IGNORE INTO bs_hypotheses (id, title, question, created_at) VALUES
  ('treasury-demand', 'Bitcoin treasury demand is increasing', 'Are corporate and sovereign balance sheets accumulating bitcoin?', '2026-10-25T00:00:00.000Z'),
  ('retained-asset', 'Bitcoin is becoming a retained monetary asset', 'Do businesses keep bitcoin instead of converting it to fiat on receipt?', '2026-10-25T00:00:00.000Z'),
  ('lightning-commerce', 'Lightning is increasing real commercial payment activity', 'Is Lightning payment volume growing in commerce, rather than only public capacity and channel counts?', '2026-10-25T00:00:00.000Z'),
  ('sovereign-downstream', 'Sovereign settlement creates downstream commercial adoption', 'Does documented settlement between states lead to business-level bitcoin use?', '2026-10-25T00:00:00.000Z'),
  ('stablecoin-substitution', 'Stablecoins capture payments without equivalent bitcoin demand', 'Are dollar stablecoins absorbing payment demand that creates little or no bitcoin demand?', '2026-10-25T00:00:00.000Z'),
  ('carry-persistence', 'Funding and basis inefficiencies persist after realistic costs', 'Does funding or basis carry survive fees and slippage consistently across venues?', '2026-10-25T00:00:00.000Z');

INSERT OR IGNORE INTO bs_settings (key, value_json, updated_at) VALUES
  ('alerts.notifications', '{"enabled":false,"email_to":""}', '2026-10-25T00:00:00.000Z'),
  ('alerts.rules', '{"funding_threshold_bps_8h":5,"funding_sustained_periods":6,"funding_window_hours":48,"treasury_change_pct":2,"treasury_change_btc":1000,"stale_multiplier":3,"error_streak":3}', '2026-10-25T00:00:00.000Z'),
  ('arbitrage.assumptions', '{"feeBpsPerLeg":2,"slippageBpsPerLeg":1,"legs":4,"holdingDays":30}', '2026-10-25T00:00:00.000Z');
