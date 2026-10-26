# Bitcoin Signals data rights — 2026-10-25

This review applies to one US-resident operator's private, noncommercial personal
research. Only that operator's administrator account is intended to receive the
measurements, derived calculations and exports. Cloudflare hosting, D1 history,
private browser display and self-exports do not themselves constitute commercial
redistribution. Existing membership capabilities do not establish a wider audience. The sole-owner
identity check applies to Signals API and research status even for global admins;
ordinary membership management cannot grant another account market-data access.
A wider audience or commercial use needs a new review, not a new feature here.

Categories: **1** expressly permitted personal use; **2** reasonably defensible
personal use with stated ambiguity; **3** a concrete prohibition or unresolved
impediment for this use. These are documented interpretations, not provider
approvals. `src/bitcoin-signals/policy.ts` enforces the current collection/reporting
choices. A successful public request proves availability, not contractual rights.

| Provider | Category for this use | Working-tree decision |
| --- | --- | --- |
| Coinbase Exchange | 1 | Enabled; personal research, no outside distribution or benchmark use. |
| Kraken spot / Futures public data | 2, strongly supported by specific API documentation | Enabled; restores funding and dated-futures basis without any trading account. |
| Deribit | 1 for personal data processing; 3 for this US resident's access | Disabled; residency restriction is independent of data licensing. |
| OKX | 2, operator accepted private personal-analysis reading | Enabled for existing public endpoints, with no access bypass. |
| CoinGecko | 2, operator accepted personal research/storage reading and retention exception | Enabled daily with attribution; narrow exception recorded in AGENTS.md. |
| mempool.space | 2, ordinary published API use | Enabled; attributed, reported network statistics. |

## Coinbase

[Market Data Terms §§2–3](https://www.coinbase.com/legal/market_data) expressly
permit “personal or research purposes.” Their audience restriction fits the
confirmed single user; one's own CSV download is not distribution to an outsider.
There are express restrictions on benchmarks and financial-product valuations,
even internally: retain the existing last-trade quote use, not an invented pricing
benchmark. [Public REST limits](https://docs.cdp.coinbase.com/exchange/rest-api/rate-limits)
are 10 requests/second/IP, burst 15. The collector makes one per hourly run.

## Kraken: restore useful coverage

[Public endpoint documentation](https://support.kraken.com/articles/360000919986-public-endpoint-examples-you-can-try-them-directly-in-a-web-browser-)
authorizes account-free historical/live data retrieval with HTTP clients.
The [derivatives API introduction](https://support.kraken.com/articles/360022635512-introduction-derivatives)
states “Anyone can use the public methods” and expressly describes automatic code
requests. Its private methods separately require a verified client and API keys.
The [API notices](https://docs-legacy.kraken.com/api/docs/guides/global-intro/)
single out “any non-personal commercial use” as requiring permission.

There is genuine textual tension with [general terms §§8–9](https://www.kraken.com/legal/global-terms),
which broadly restrict extraction, automation and third-party applications.
Our supported interpretation reads the specific published API instructions as
permission for this ordinary personal API use. Treating those instructions as
meaningless and demanding a commercial license would be unnecessarily restrictive.
There is no third-party market-data service or trading access here. Product
eligibility for placing offshore derivatives orders is not inferred to prohibit
reading these expressly public methods. Actual access blocks remain binding.

Each collector makes one hourly request. [Futures limits](https://docs.kraken.com/exchange/guides/futures/ratelimits)
assign no public-call budget cost; that is a quota rule, not the licensing rationale.
Quotes and funding retain the exchange timestamp; spot's missing trade timestamp
is disclosed as retrieval time. Funding is a one-hour relative rate normalized to
eight hours, not guaranteed income; basis uses the same venue's mark and index.

## Deribit: personal exception, US access restriction

[Terms §32.3](https://support.deribit.com/hc/en-us/articles/25944471089437-Terms-of-Service-DRB-Panama-Inc)
permit market/derived-data processing “except for personal use” from the otherwise
restricted activities. Private calculations and history fit that exception; a
commercial written license is not the missing requirement.
However, [Restricted Jurisdictions](https://support.deribit.com/hc/en-us/articles/25944487427741-Restricted-Jurisdictions)
prohibits platform/services access for US residents, not just order execution.
The operator has confirmed US residency. A VPN or foreign Worker location does
not remove that restriction. Keep the adapter offline and retained rows excluded.

## OKX: no blanket claim that a private dashboard competes

[API Agreement §9.4](https://www.okx.com/en-us/help/okx-api-agreement) permits
“personal, non-commercial trading and account management purposes.” Third-party
distribution restrictions do not apply merely because the operator views their own
browser. The strongest reading treats this small private funding/basis analysis
as personal trading research, not a competing data product or commercial substitute.
Automated public access is contemplated at a scale reasonably necessary for that
purpose; no commercial licensing request is automatically needed.

The purpose limitation and analytics-product language remain interpretive, rather
than a confirmed ban on this private use. The operator accepted the personal-analysis
reading and authorized restoring functionality on 2026-10-25. The
[US API page](https://www.okx.com/en-us/okx-api) expressly offers public REST data,
and the [US historical-data page](https://www.okx.com/en-us/historical-data)
offers perpetual funding history. We read public research access separately from
eligibility to open a derivatives trading account; no such account is used here.
[US terms §2](https://www.okx.com/en-us/help/terms-of-service-us) still govern
location/feature availability. An actual block or contrary provider instruction
must stop collection; do not use a VPN, alternate host, account or key to bypass it.
Four fixed requests per hourly run cover funding/current history, spot and index;
no arbitrary backfill or high-frequency service is introduced. The directly
accessible existing endpoints succeeded without bypass in the final probe.

## CoinGecko: distinguish personal licensing from retention

[API Terms §§3–4,6](https://www.coingecko.com/en/api_terms) grant application use
and contemplate storage: “if you must cache or store Data.” They call for daily
cache refresh and strong protection; §6.1.4 requires removal of every retained
copy if access is terminated. Daily new observations may reasonably coexist with
dated history: refreshing the current view does not expressly require overwriting
historical measurements. Self-exports are not resale or redistribution.

[Licensing guidance](https://support.coingecko.com/articles/1043089972-what-are-the-differences-between-commercial-and-custom-licenses)
requires paid rights for commercial use, which this tool is not. Its retention FAQ
expressly assures paid subscribers; it does not expressly settle free personal
historical storage. Reading §6's conditional storage permission to cover private
noncommercial history is defensible, but not an unqualified provider assurance.
A paid plan alone would not remove the termination-deletion obligation.

The operator accepted this documented personal-use interpretation and authorized
the narrow termination-retention exception on 2026-10-25. It is recorded in
[AGENTS.md](../AGENTS.md) and the [backup runbook](BACKUP-RESTORE.md): unrelated
history stays protected; any future production deletion/lock change still needs
a concrete scoped operator approval. No deletion or infrastructure change occurred
now. Existing R2 locks are configurable, not irrevocable; do not mislabel backups
as published reports to evade deletion. The normal backup client gains no delete
method. This resolves the internal policy conflict without a new service or plan.

The adapter is enabled daily and linked **Powered by CoinGecko** attribution is
restored. [Keyless access](https://docs.coingecko.com/docs/errors-and-rate-limits)
is documented and IP-limited; restrictions fail without borrowed keys, proxy
rotation or retries. Treasury values remain reported holdings, not a CFLab filings
audit. [D1](https://developers.cloudflare.com/d1/reference/data-security/) and
[R2](https://developers.cloudflare.com/r2/reference/data-security/) document
automatic AES-256 storage encryption and TLS; exports/local drill copies remain
private operator artifacts. No new plan, secret or service was introduced.

## mempool.space and suitable alternatives

The maintainer's [hosted API terms](https://raw.githubusercontent.com/mempool/mempool/master/frontend/src/app/components/terms-of-service/terms-of-service.component.html)
cover the service and disclaim accuracy/availability; no ban on this bounded
personal statistics use was found. This is a supported inference, not an SLA.
Dataset identity/retrieval provenance remain visible; public channel capacity is
not payment volume. No numeric public quota is promised; HTTP 429 ends that source.

[SEC EDGAR](https://www.sec.gov/about/developer-resources) provides public filings
and JSON APIs under fair access (10 requests/second total). Primary filings and
issuer disclosures are suitable attributed treasury evidence through the existing
curated workflow. They are not a drop-in automated company-holdings aggregate;
no new collector is added in this review.

[Coin Metrics Community](https://gitbook-docs.coinmetrics.io/packages/coin-metrics-community-data)
links CC BY-NC 4.0, suitable for attributed noncommercial research; no key is needed,
with 10 requests/6 seconds/IP. The offering is a subset of paid products. Actual
free BTC funding/basis coverage has not been verified, so no claim or integration
is made for it. Restoring the existing Kraken adapter avoids expanding scope.

Disabled-source rows and alerts are quarantined from all reports, not deleted.
The persistent development store was empty at initial inspection; any subsequent
real-data persistence drill uses separate isolated storage. The new production
database is unmigrated and contains no test dataset. Synthetic parser fixtures remain offline.
No proxy/VPN, geography change, credential, deployment, or production data write
was performed for this review.

The final enabled-only real-data probe parsed 164 observations from six providers.
An isolated durable D1 run also stored 111 hourly and 53 daily observations; cached
repeats added zero and preserved all original rows. A separate local dump/restore
verified 13 tables/198 rows, schema/row hashes and integrity. These checks exercised
real data without production writes or email. See the
[audit evidence](BITCOIN-SIGNALS-AUDIT.md#final-real-data-persistence-and-restore-drill).
