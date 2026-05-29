# Vite 8 Migration Plan

Date: 2026-05-28

## Why This Matters

CIDRella currently builds the client with Vite 5.4.21. Vite's current support window is Vite 8 for regular fixes, Vite 7.3 for important/security fixes, and Vite 6.4 for security backports. Vite 5 is outside that window, and `npm audit` reports dev-only moderate findings that require a Vite major upgrade to clear.

The goal is to move the frontend toolchain to a supported Vite line, preferably Vite 8, without mixing this into release-time automatic dependency updates.

## Current State

Client runtime dependencies:

- `vue` 3.5.35
- `vue-router` 4.6.4
- `pinia` 2.3.1
- `primevue` 4.5.5
- `@primeuix/themes` 2.0.3
- `chart.js` 4.5.1
- `vue-chartjs` 5.3.3

Client build/test dependencies:

- `vite` 5.4.21
- `@vitejs/plugin-vue` 5.2.4
- `vitest` 4.1.7

Known npm metadata:

- `vue-router` 5.1.0 peers on `vite ^7.0.0 || ^8.0.0`, `pinia ^3.0.4`, `vue ^3.5.34`, and `@vue/compiler-sfc ^3.5.34`.
- `pinia` 3.0.4 peers on `vue ^3.5.11`.
- `@vitejs/plugin-vue` 6.0.7 peers on Vite 5/6/7/8 and Vue 3.2.25+.
- `vitest` 4.1.7 peers on Vite 6/7/8, so it is compatible with the target Vite range.

## Proposed Target

Upgrade together:

- `vite` to `^8.0.14`
- `@vitejs/plugin-vue` to `^6.0.7`
- `vue-router` to `^5.1.0`
- `pinia` to `^3.0.4`

Keep unless npm resolver indicates otherwise:

- `vue` on `^3.5.0` or tighten to `^3.5.35`
- `primevue` 4.x
- `@primeuix/themes` 2.x
- `chart.js` 4.x
- `vue-chartjs` 5.x
- `vitest` 4.x

## Execution Status

Completed on 2026-05-28.

Applied package changes in `client/`:

- `vite` `^8.0.14`
- `@vitejs/plugin-vue` `^6.0.7`
- `vue-router` `^5.1.0`
- `pinia` `^3.0.4`

Validation completed:

- `npm audit --omit=dev` clean in `client/`
- `npm audit --omit=dev` clean in `server/`
- `npm run build` in `client/` passes on Vite 8
- client Vitest suite passes
- server Vitest suite passes
- `npm run check:db-ownership` passes
- `./scripts/build-release.sh --dry-run --pre pre.4` passes
- `./scripts/build-release.sh --build-only --pre pre.4` builds the client, stages bundled Node `24.16.0`, compiles native server modules against that runtime, creates `dist/cidrella-v0.4.15-pre.4-linux-x64.tar.gz`, and stops at the expected `minisign` password prompt

Remaining dependency modernization was completed separately on 2026-05-29:

- Express 4 to 5
- `better-sqlite3` 11 to 12

## Migration Steps

1. Create a clean branch or confirm the current working tree contains only intended dependency/runtime changes.

2. Confirm the Node 24/raw-socket removal work is either committed or intentionally included:
   - `net-ping` removed from `server/package.json`
   - scanner uses system `ping` for ICMP fallback
   - Docker and bundled runtime use Node 24
   - release build can compile server production modules under Node 24

3. In `client/`, run a targeted package install:

   ```bash
   NPM_CONFIG_CACHE=/home/mcnultyd/dev/cidrella/dist/.npm-cache npm install --save vite@^8.0.14 @vitejs/plugin-vue@^6.0.7 vue-router@^5.1.0 pinia@^3.0.4
   ```

4. If npm requests peer alignment, prefer minimal explicit bumps:
   - `vue@^3.5.35`
   - `@vue/compiler-sfc` only if it appears explicitly in the dependency graph or Vite plugin flow requires it.

5. Run static/package checks:

   ```bash
   cd client
   npm audit
   npm outdated --omit=dev
   npm run build
   ./node_modules/.bin/vitest run --reporter=dot
   ```

6. Fix client code or Vite config issues if they appear:
   - Check `client/vite.config.js` first.
   - Check router initialization and route definitions if Vue Router 5 surfaces warnings.
   - Check store initialization if Pinia 3 surfaces warnings.
   - Check chart rendering if bundling/chunking changes affect Chart.js tree-shaking.

7. Run full project validation:

   ```bash
   cd /home/mcnultyd/dev/cidrella/server
   ./node_modules/.bin/vitest run --reporter=dot

   cd /home/mcnultyd/dev/cidrella/client
   ./node_modules/.bin/vitest run --reporter=dot

   cd /home/mcnultyd/dev/cidrella
   npm run check:db-ownership
   ./scripts/build-release.sh --dry-run --pre pre.4
   ./scripts/build-release.sh --build-only --pre pre.4
   ```

8. Manually smoke test the UI:
   - Dashboard loads
   - Networks table and grid view render
   - DHCP table renders
   - DNS table renders
   - Settings pages render, especially Themes and Interfaces
   - Analytics charts render after a theme switch and after page reload

9. If all validation passes, commit as a focused frontend toolchain migration.

10. Update release notes with:
    - Vite 8 frontend build toolchain
    - Vue Router 5 / Pinia 3
    - dev audit findings resolved

## Risks And Watch Points

- Vite 8 may introduce config or plugin behavior changes even if the app code is mostly unaffected.
- Vue Router 5 documentation says Vue Router 4 apps without file-based routing should not need code changes, but its peer dependencies intentionally pull the app onto the newer Vite/Pinia/Vue stack.
- Dev audit findings are not shipped runtime vulnerabilities, but unsupported Vite 5 is a maintenance gap.
- Do not use `--force` or `--legacy-peer-deps` for this migration. If npm cannot resolve cleanly, stop and inspect the package graph.

## Deferred Dependency Work

These were related modernization opportunities kept separate from the Vite 8 migration and completed on 2026-05-29:

- Express 4 to 5.
- `better-sqlite3` 11 to 12.

Still deferred:

- Further release-script changes for major-upgrade handling.
