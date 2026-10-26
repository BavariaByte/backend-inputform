# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [Semantic Versioning](https://semver.org/).

## [1.1.1] - 2026-10-25

### Security
- Pin the Node.js base images to 22.23.4 (Docker build/runtime stages and CI
  jobs), picking up the Node.js security release of 2026-10-21
  (CVE-2026-111497 Brotli out-of-bounds write, CVE-2026-105482 dns.resolve NUL
  truncation, CVE-2026-106069 TLS IPv4 cert check bypass, CVE-2026-105481
  keep-alive request smuggling, updated c-ares, OpenSSL, Undici and root
  certificates).
- Resolve all `npm audit` findings via lockfile updates (no package.json
  changes): proxy-addr 2.0.7 → 2.0.8 (GHSA-jqcg-44mw-7w3h, critical),
  body-parser 2.3.0 → 2.4.0 (GHSA-27r3-jxmh-p828), qs 6.15.3 → 6.16.1
  (GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g), morgan 1.11.0 → 1.12.1
  (GHSA-jxfw-x594-9x9m, GHSA-9f6g-j8ch-79g4), fast-copy 4.0.3 → 4.3.0
  (GHSA-jggr-w7fw-pc2j), brace-expansion 5.0.9 → 5.0.12 (GHSA-q2hr-2g5m-vwhr,
  GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p).

## [1.0.0] - 2026-08-09

### Added
- First public release: lean ingestion API of the GIRP platform — anonymous
  form sessions with short-lived JWTs, completed incident submissions,
  hardened uploads and abuse protection.
- Playbooks that sit in the Backend-SOCView trash are not served to the intake
  form; they disappear as soon as they are deleted, without waiting for their
  permanent removal.
