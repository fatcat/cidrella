# Review/Fix Loop

Started: 2026-05-28

Scope:
- Code quality: code reuse, DRY, hard-coded logic where generalized approaches are clearly better, consistency, maintainability, and appropriate error handling.
- Security: common web risks including injection, XSS, auth/authorization gaps, unsafe file/path handling, unsafe command execution, request validation, token leakage, and related exploit classes.

Process:
1. Run independent code-quality and security review agents.
2. Triage each finding as `fix`, `defer`, or `invalid`.
3. Implement fixes for actionable findings.
4. Run focused validation.
5. Rerun reviewers until no high-value actionable findings remain.

## Iteration 1

Status: fixed; reviewer rerun pending

Reviewers:
- Code quality reviewer: `019e6ec4-3842-7a00-8575-37427ec5c826`
- Security reviewer: `019e6ec4-4bca-7470-8071-827fd5deba55`

Findings:
- CQ-1 HIGH: malformed `anomaly_daemon_status` JSON can make the Python sidecar's error/status reporting fail recursively.
- CQ-2 MEDIUM: anomaly stale fallback default is hard-coded to 10 minutes while the daemon/server defaults use 15 minutes.
- CQ-3 MEDIUM: hostname enrichment is duplicated in `analytics.js` and `anomalies.js`.
- CQ-4 LOW: malformed `top_features` JSON can turn anomaly read routes into 500s.
- SEC-1 MEDIUM-HIGH: read-only users can trigger active probes, and `subnet_id` probe path does not verify target IP membership.
- SEC-2 MEDIUM: backup restore validation rejects bad paths but not symlink/hardlink/device archive entries.
- SEC-3 MEDIUM: outbound URL guard validates hostname once, but later fetches by hostname and can be DNS-rebound.

Fixes:
- CQ-1: `server/anomaly/storage.py` now tolerates malformed/non-object `anomaly_daemon_status` JSON and resets the status document instead of throwing. `server/anomaly/anomaly_detector.py` now writes daemon status through a safe wrapper so status persistence failures do not kill the main loop.
- CQ-2: anomaly stale detection now uses `DEFAULTS.anomaly_scoring_interval_min` instead of a hard-coded 10-minute fallback.
- CQ-3: hostname enrichment is centralized in `server/src/utils/hostnames.js` and reused by Analytics and Anomalies routes.
- CQ-4: anomaly score row parsing now treats malformed `top_features` JSON as `null` instead of returning a 500.
- SEC-1: targeted probes now require `subnets:write`; an explicit `subnet_id` must exist, be allocated, and contain the probed IP.
- SEC-2: backup inspection now rejects symlink, hardlink, and device tar entries; restore extraction uses safer tar ownership/permission flags and validates the staged tree contains only directories and regular files.
- SEC-3: outbound URL fetches now use `requestPinnedOutboundUrl`, which connects to the validated IP and preserves Host/SNI. Pi-hole fetch/probe and blocklist refresh use this helper.

Validation:
- `node --check` passed for changed JS modules:
  `server/src/routes/anomalies.js`, `server/src/routes/analytics.js`, `server/src/routes/scans.js`, `server/src/routes/pihole.js`, `server/src/utils/url-guard.js`, `server/src/utils/backup.js`, `server/src/utils/blocklist.js`, `server/src/utils/hostnames.js`.
- Python AST parse passed for `server/anomaly/storage.py` and `server/anomaly/anomaly_detector.py`.
- `npm test` passed: server 25 files / 336 tests; client 2 files / 25 tests.

Deferred:
- None in iteration 1.

## Iteration 2

Status: fixed; reviewer rerun pending

Reviewers:
- Code quality reviewer: `019e6ecc-a6e4-7793-a1ec-2441d90464c7`
- Security reviewer: `019e6ecc-a88c-74f1-9d08-9b8519522790`

Findings:
- CQ-5 MEDIUM: `listTarEntries()` silently ignored non-empty tar verbose-listing lines it could not parse.
- CQ-6 MEDIUM: backup restore reused compatibility inspection but still reparsed the archive listing for size analysis.
- CQ-7 LOW-MEDIUM: Pi-hole URL handling validated/resolved the base URL, then validated/resolved again for each request.
- SEC-4: no high-value actionable security findings.

Fixes:
- CQ-5: `listTarEntries()` now fails closed when a non-empty tar-listing line cannot be parsed.
- CQ-6: `inspectBackup()` now returns archive `analysis`, and `restoreBackup()` reuses it when supplied by the caller.
- CQ-7: Pi-hole normalization now returns the validated outbound target, and follow-up auth/config requests reuse the pinned IP data while changing only the URL path/query.

Validation:
- `node --check` passed for `server/src/utils/backup.js`, `server/src/utils/url-guard.js`, and `server/src/routes/pihole.js`.
- `npm test` passed: server 25 files / 336 tests; client 2 files / 25 tests.

Deferred:
- None in iteration 2.

## Iteration 3

Status: complete

Reviewers:
- Code quality reviewer: `019e6ece-9881-7b20-be8f-0acdeab18c56`
- Security reviewer: `019e6ece-9a22-7bc1-b373-2ed45646c827`

Findings:
- No high-value actionable maintainability findings remain.
- No high-value actionable web/security findings remain.

Fixes:
- Updated a stale Pi-hole URL normalization comment noted by the maintainability reviewer as minor cleanup.

Validation:
- Prior full validation remained green after iteration 2. Final syntax check run after the comment-only cleanup.

Deferred:
- None in iteration 3.
