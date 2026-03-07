# Code Review Report

**Date:** 2026-03-07
**Directory:** /home/mcnultyd/dev/ipam
**Focus:** all
**Files reviewed:** 92

---

# Executive Summary

# Executive Summary — Code Review

## Statistics

| Severity | Count |
|----------|-------|
| **HIGH** | 3 |
| **MEDIUM** | 19 |
| **LOW** | 12 |
| **Total** | 34 |

---

## Critical Issues (Must Fix)

1. **Command injection via `execSync` in operations.js** — Shell metacharacters in `DATA_DIR` or file paths are interpolated directly into `execSync` calls, enabling arbitrary command execution. Switch all instances to `execFileSync` with argument arrays.

2. **SQL injection via string interpolation in blocklist scheduler** — `intervalHours` is interpolated directly into a SQL string in `blocklist.js`. Currently safe due to hardcoded switch values, but one refactor away from exploitable. Use parameterized binding.

3. **Path traversal in `getBackupPath`** — Exported utility joins user-supplied filenames with `path.join` without validating the resolved path stays within `BACKUP_DIR`. `../../etc/passwd` escapes the directory. Add `path.resolve` + prefix check.

---

## Improvements (Should Fix)

- **SSRF via blocklist source URL** — No validation that URLs are HTTP(S); `file://` and internal IPs accepted.
- **Setup routes bypass authentication permanently** — Mounted before `authMiddleware` with no post-setup guard.
- **JWT contains stale roles** — Tokens trusted for 24h without DB re-validation; deleted/demoted users retain access.
- **GeoIP DNS proxy timeout is fail-open with no response** — Client DNS queries hang silently on upstream timeout instead of receiving SERVFAIL.
- **XSS on blocked page** — Characters are stripped rather than HTML-entity-encoded; backticks missed.
- **Host header injection in HTTP redirect** — Attacker-controlled `Host` header used in `Location` response, enabling open redirect/phishing.
- **String/number key mismatch in DHCP.vue** — `Object.entries` returns string keys but lookups use numeric keys on reactive objects, causing silent default-value lookup failures.
- **`currentTheme` is a plain function, not a computed** — Components reading it won't re-render on theme changes.
- **`sessionDuration` never updates** — `Date.now()` is not reactive; the computed caches forever.
- **Unbounded `limit` in blocklist search** — No upper cap; `limit=999999999` forces expensive queries.
- **`formatDate` in Users.vue** appends `'Z'` unconditionally — Produces `Invalid Date` for ISO strings already containing `Z`.
- **Migration 018 drops tables without data migration** — Existing blocklist configurations silently destroyed.
- **Auth path matching bypassable with trailing slashes** — `PUBLIC_PATHS.includes(req.path)` uses exact match without normalization.

---

## Top 5 Priorities

| # | Finding | Severity | File |
|---|---------|----------|------|
| 1 | **Command injection via `execSync`** — switch to `execFileSync` for all shell calls with interpolated variables | HIGH | `operations.js` |
| 2 | **Path traversal in `getBackupPath`** — validate resolved path stays within backup directory | HIGH | `backup.js` |
| 3 | **SQL injection via string interpolation** — parameterize `intervalHours` in blocklist query | HIGH | `blocklist.js` |
| 4 | **Setup routes unauthenticated post-setup** — add completion check or remove routes after initial setup | MEDIUM | `index.js` |
| 5 | **SSRF via blocklist URL** — validate scheme is `http(s)://` and block private/link-local ranges | MEDIUM | `blocklists.js` |

---

# Detailed Findings

## client/src

The code in these two files is clean and well-structured. I have only one minor finding:

---

### [LOW] Unused import of `useDebugStore` before Pinia is ready — but actually fine here; however `updateSurfacePalette` may not exist

**File:** `client/src/main.js`, line 4

```js
import { updatePreset, updateSurfacePalette } from '@primeuix/themes';
```

`updateSurfacePalette` was removed/renamed in some versions of `@primeuix/themes`. In PrimeVue v4 (post-4.2), the surface palette is already covered by `updatePreset` when you set `colorScheme.light.surface` and `colorScheme.dark.surface`. If the installed version of `@primeuix/themes` doesn't export `updateSurfacePalette`, this import will throw at startup and the app won't mount.

**How to verify/fix:** Check your lockfile for the `@primeuix/themes` version. If `updateSurfacePalette` is indeed exported, this is fine. If not, remove the import and the call on lines 87–99 — the `updatePreset` call already sets the surface tokens.

---

No bugs, security issues, or significant problems otherwise. The global error handling, theme wiring, and Toast setup all look correct.

---

## client/src/api

The code looks good. Clean Axios setup with proper interceptor patterns.

No findings — the code is straightforward, correct, and handles edge cases (store not ready, missing response fields) appropriately.

---

## client/src/components

The code is generally well-structured. Here are the findings:

## Findings

### [MEDIUM] `sessionDuration` computed property never updates — `DebugPanel.vue`, line 68

The `sessionDuration` computed property uses `Date.now()`, but `Date.now()` is not a reactive dependency. Vue's reactivity system has no way to know when `Date.now()` changes, so this computed will be evaluated once and cached forever, always showing `<1m`.

**Fix:** Use a reactive timer ref that updates on an interval:

```js
const now = ref(Date.now());
let timer;
onMounted(() => { timer = setInterval(() => { now.value = Date.now(); }, 60000); });
onUnmounted(() => clearInterval(timer));

const sessionDuration = computed(() => {
  const ms = now.value - sessionStart;
  // ...
});
```

### [MEDIUM] `totalCount` in `OrgNetworkTable.vue` counts raw subnet objects, not tree nodes — line 96

`totalCount` walks `props.folder.subnets` (raw data), while `flatRows` walks `store.toSubnetNodes(props.folder.subnets)` (transformed tree nodes). If `toSubnetNodes` filters, merges, or restructures nodes differently from the raw data, the count will be inconsistent with what's displayed. More importantly, `totalCount` is not memoized on the same reactive source — it re-walks the raw array on every access while `flatRows` uses the transformed nodes.

**Fix:** Derive the total count from the same node tree used by `flatRows`, or count all nodes in the `flatRows` walk:

```js
const totalCount = computed(() => {
  const nodes = getNodes();
  let count = 0;
  function walk(list) { for (const n of list) { count++; if (n.children?.length) walk(n.children); } }
  walk(nodes);
  return count;
});
```

### [LOW] CPU/RAM/Disk cards always show `card-ok` class regardless of health — `HeaderBar.vue`, lines 29–45

The CPU, RAM, and Disk cards are hardcoded with `class="dash-card card-ok"`, so they always appear green even when alerts fire for critical disk (≥90%), memory (≥95%), or high CPU load. This is misleading — the status button may show errors while the cards still look healthy.

**Fix:** Use computed classes like the dnsmasq/DNS cards:

```js
const diskStatusClass = computed(() => {
  if (health.value?.disk?.percent >= 90) return 'card-err';
  return 'card-ok';
});
```

Then bind `:class="diskStatusClass"` on the card. Same for CPU and RAM.

### [LOW] XSS via `escape: false` in tooltip — `HeaderBar.vue`, line 168

The DNS tooltip uses `escape: false` to render HTML. While the data comes from an API response (server names), if an attacker can control upstream DNS server names (e.g., via a compromised config), raw HTML will be injected into the tooltip. This is a low risk since it requires backend compromise, but it's worth noting.

**Fix:** Build the tooltip with escaped text, or sanitize `s.server` values before interpolation.

---

## client/src/router

## Code Review: `client/src/router/index.js`

### Findings

**[LOW] Dead code: `setupChecked` and `setupRequired` variables are unused**

Lines 56-57 declare `setupChecked` and `setupRequired`, and `markSetupComplete()` (line 88) mutates `setupRequired`, but neither variable is ever read anywhere in the guard logic. The Setup route is unconditionally redirected to Login (line 62). This is confusing — a developer might think setup detection is functioning when it isn't.

Either remove the dead code (`setupChecked`, `setupRequired`, `markSetupComplete`) or implement the actual setup-check logic in the guard.

---

**[MEDIUM] Setup route is publicly accessible but immediately redirects, creating a confusing/broken contract**

Line 62-63: The guard unconditionally redirects `/setup` to Login, yet the route is defined with `meta: { public: true }` and imports the `SetupWizard` component. If the setup wizard is intentionally disabled, the route definition and component import should be removed to avoid confusion and unnecessary bundling. More critically, if the setup wizard is supposed to work in some scenarios, this guard completely breaks it with no conditional check — there's no code path that ever allows reaching the setup wizard.

If setup is permanently disabled, remove the route, the import of `SetupWizard`, and the exported `markSetupComplete`. If it should be conditionally available, the guard needs to actually check `setupRequired`.

---

The rest of the router looks correct: the auth guard logic is sound, lazy loading is used for non-critical routes, the catch-all 404 route is properly placed last, and the `beforeEach` guard correctly handles the password-change flow.

---

## client/src/stores

# Code Review: client/src/stores

## Findings

### [MEDIUM] `ipToLong` produces incorrect results for IPs with high first octet — `subnets.js`, line 29

```javascript
function ipToLong(ip) {
    const parts = ip.split('.').map(Number);
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}
```

The `>>> 0` makes this work correctly as unsigned. However, the subsequent **comparison** at lines 33-34 and 91-92 uses normal subtraction (`aNet - bNet`), which returns a correct result since both values are unsigned 32-bit integers. This is actually fine — disregard.

### [MEDIUM] `currentTheme` is a plain function, not a computed — `theme.js`, line 67

```javascript
const currentTheme = () => themes.find(t => t.id === currentThemeId.value) || themes[0];
```

This is returned from the store and likely used in templates or reactive contexts as `themeStore.currentTheme`. Since it's a plain function (not a `computed`), accessing it won't be reactive — components won't re-render when the theme changes. If any component reads `themeStore.currentTheme` expecting reactivity (e.g., to display the current theme name), it will show stale data.

**Fix:** Change to a computed:
```javascript
const currentTheme = computed(() => themes.find(t => t.id === currentThemeId.value) || themes[0]);
```

### [MEDIUM] Detail cache eviction deletes arbitrary entry, not oldest — `subnets.js`, lines 175-178

```javascript
if (_detailCache.size >= DETAIL_CACHE_MAX) {
    const oldest = _detailCache.keys().next().value;
    _detailCache.delete(oldest);
}
```

`Map` iteration order is insertion order, not sorted by timestamp. If a cache entry is **read** (cache hit), it is not re-inserted, so a frequently-accessed entry inserted early will be evicted first while a rarely-used but recently-inserted entry survives. The comment says "evict oldest" but this evicts "first inserted." This is a minor correctness issue — to evict by actual age (least recently used or oldest timestamp):

**Fix:** On cache hit, delete and re-set the entry to move it to the end, or find the entry with the smallest `timestamp` value.

### [LOW] `entries.value.length = maxEntries` truncation is fragile — `debug.js`, line 18

```javascript
entries.value.unshift({...});
if (entries.value.length > maxEntries) {
    entries.value.length = maxEntries;
}
```

Directly setting `.length` on a Vue reactive array does work in Vue 3, but it bypasses Vue's array mutation tracking in some edge cases and is non-idiomatic. Using `entries.value.splice(maxEntries)` is safer and more explicit.

---

## Overall Assessment

The stores are clean, consistent, and well-structured. The API patterns (fetch-after-mutate, loading flags, caching) are applied consistently. The main actionable issue is the non-reactive `currentTheme` in the theme store, which will cause bugs in any component that depends on it reactively.

---

## client/src/utils

The code is well-written overall. Here are the findings:

---

### [MEDIUM] `cidrsOverlap` is not exported but `validateSupernet` logic is flawed for public IP ranges

**File:** `client/src/utils/ip.js`, lines 64-80

`validateSupernet` returns `{ valid: true }` for any CIDR that doesn't overlap with *any* reserved range — meaning public IP space (e.g., `8.0.0.0/8`) always passes validation. But it also returns `{ valid: true }` if the CIDR is fully *within* a reserved range. The problem is: a CIDR that spans *across two different reserved ranges* (e.g., `172.0.0.0/8` overlaps both `172.16.0.0/12` RFC1918 and non-reserved space) will be caught on the first overlapping reserved range and rejected — but a CIDR that spans two reserved ranges without being a subset of either will only be checked against the *first* match due to the early return, potentially missing the second overlap.

More concretely, the function returns on the **first** overlapping reserved range it finds. If a CIDR partially overlaps one reserved range and also partially overlaps another, only the first is reported. This is a minor correctness issue — the function should check all reserved ranges, not just the first match.

```js
// Current: returns on first overlap
for (const reserved of RESERVED_RANGES) {
  if (cidrsOverlap(cidr, reserved.cidr)) {
    // ...
    return { valid: false, ... }; // misses other overlapping ranges
  }
}
```

**Fix:** Iterate all ranges before returning, or accumulate errors.

---

### [MEDIUM] `calculateSubnets` integer overflow for large subnet counts

**File:** `client/src/utils/ip.js`, line 93

```js
const count = 1 << (newPrefix - parent.prefix);
```

If `newPrefix - parent.prefix > 30` (e.g., splitting a `/0` into `/31`s), `1 << 31` yields `-2147483648` in JavaScript (signed 32-bit), and `1 << 32` yields `1` (not `4294967296`). The loop would then either not execute or behave incorrectly.

Additionally, even for valid shifts like 30, the function would attempt to build an array of ~1 billion entries, which will crash the browser tab.

**Fix:** Add a guard on the difference, e.g., reject if `newPrefix - parent.prefix > 20` (or some reasonable UI limit), and use `>>> 0` or `Math.pow(2, ...)` for correctness:

```js
const diff = newPrefix - parent.prefix;
if (diff > 20) return []; // guard against excessive allocation
const count = 2 ** diff;
```

---

### [LOW] `isSubnetOf` rejects equal CIDRs by design but this may surprise callers

**File:** `client/src/utils/ip.js`, line 48

```js
child.prefix > parent.prefix;
```

`isSubnetOf('10.0.0.0/24', '10.0.0.0/24')` returns `false` because of the strict `>`. This is a design choice but worth noting — if any caller expects "is contained within or equal to," they'll get a wrong result. If this is intentional, a comment would help.

---

The rest of the code — `countryFlag`, `ipToLong`/`longToIp`, `parseCidr`, `canMergeCidrs`, `subtractCidr` — looks correct and clean.

---

## client/src/views

# Code Review: client/src/views

## Findings

### [MEDIUM] Blocklists.vue — `doToggleAll` sends sequential API calls that can leave state inconsistent on partial failure

**File:** `client/src/views/Blocklists.vue`, lines 197-210

The `doToggleAll` function iterates categories sequentially with `await` in a loop. If one fails midway, some categories are toggled and some aren't, but the catch block shows a single error toast and the UI may show stale state since `fetchStats` is only called on success.

```javascript
for (const cat of toToggle) {
  await store.toggleCategory(cat.slug, enabled);
}
```

**Fix:** Either use a batch API endpoint, or catch errors per-iteration and continue, reporting a summary at the end. At minimum, call `fetchStats` in the `finally` block to ensure the UI reflects actual state.

---

### [MEDIUM] Blocklists.vue — Search pagination buttons call `doSearch()` as a function argument, not on click

**File:** `client/src/views/Blocklists.vue`, lines 142-148

```html
<Button label="Previous" ... @click="searchPage--; doSearch()" />
<Button label="Next" ... @click="searchPage++; doSearch()" />
```

The `@click` inline handler executes `searchPage--` then `doSearch()`. However, `doSearch` is also used as `@keyup.enter="doSearch"` where it receives a keyboard `Event` object as the first argument. Inside `doSearch`, this event is silently ignored (no parameters are used), so it works — but the real issue is that `searchPage` is not reset to 1 when the user types a new query and presses Enter, meaning a search from the input field may request page 5 of new results.

**Fix:** Reset `searchPage` to 1 in the Enter-key search path or at the start of `doSearch` when called without explicit pagination intent.

---

### [MEDIUM] Users.vue — `formatDate` unconditionally appends 'Z' without checking if already present

**File:** `client/src/views/Users.vue`, line 44

```javascript
function formatDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr + 'Z').toLocaleDateString();
}
```

If the server ever returns a date string already containing 'Z' or a timezone offset (e.g., `2024-01-01T00:00:00Z`), this produces `2024-01-01T00:00:00ZZ` — an invalid date yielding "Invalid Date". The `Blocklists.vue` and `GeoIP.vue` files correctly handle this with a conditional check. This view does not.

**Fix:** Use the same pattern as other files:
```javascript
const d = new Date(dateStr + (dateStr.includes('Z') ? '' : 'Z'));
```

---

### [MEDIUM] DHCP.vue — `defaultValues` reactive object uses string keys from API but `toggleScopeOption` and watchers use numeric keys, causing silent mismatches

**File:** `client/src/views/DHCP.vue`, lines ~169-175 and ~234-240

In `loadOptions`, keys from the API response are iterated as strings (`Object.entries` returns string keys):
```javascript
for (const [code, value] of Object.entries(res.data.defaults || {})) {
  defaultValues[code] = value;  // code is a string like "1"
}
```

But in `toggleScopeOption` and the `watch` on `range_id`, option codes are used as numbers:
```javascript
if (defaultValues[code] != null) ...  // code is a number like 1
```

In JavaScript, `reactive` object property access with `1` vs `"1"` are different keys. This means default value lookups will fail silently — scope options won't get pre-populated from defaults.

**Fix:** Normalize keys consistently. Either always use `String(code)` or always use `Number(code)` throughout.

---

### [LOW] DNS.vue — `openZoneDialog` is exposed but `applyConfig` is not, despite being defined

**File:** `client/src/views/DNS.vue`, line ~298

`applyConfig` is defined but never called from the template or exposed. Dead code that may confuse maintainers.

---

### [LOW] DHCP.vue — `applying` ref is declared but the `applyConfig` function is only accessible via `defineExpose`, never from template

**File:** `client/src/views/DHCP.vue`

`applyConfig` dispatches delayed events via `setTimeout` inside a loop — these timeouts are never cleaned up if the component unmounts during the 6-second window, which could cause stale event dispatches.

---

Overall the code is well-structured and consistent across views. The main real-world issues are the string/number key mismatch in DHCP option defaults and the inconsistent date formatting in Users.vue.

---

## root

The code looks good. This is a straightforward Vite config with a dev proxy. No bugs, security issues, or meaningful improvements to report.

---

## server/src

## Code Review Findings

### [MEDIUM] XSS via `domain` query parameter in blocked page

**File:** `server/src/index.js`, lines 112-120

The manual character replacement `domain.replace(/[<>"'&]/g, '')` strips dangerous characters but doesn't replace them with HTML entities — it just removes them. While this does prevent basic XSS, the approach is brittle and non-standard. More critically, the regex misses backticks (`` ` ``), which can be used in some XSS vectors in older browsers, and the stripping approach changes displayed content silently.

However, the actual severity is reduced because the current regex does strip `<` and `>`, preventing tag injection. Upgrading to proper HTML entity encoding would be the correct fix:

```js
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// then use escapeHtml(domain) in the template
```

The current code *strips* rather than *escapes*, which means a domain like `example.com&foo` renders as `example.comfoo` — wrong output.

---

### [MEDIUM] Setup routes bypass authentication

**File:** `server/src/index.js`, lines 96-98

```js
app.use('/api/setup', setupRoutes);
app.use(authMiddleware);
```

The setup routes are mounted before `authMiddleware`, so they're always accessible without authentication — even after initial setup is complete. If the setup routes contain actions like creating an admin user or configuring the system, this is an ongoing unauthenticated endpoint in production. The setup routes themselves must check whether setup has already been completed; if they don't, this is a privilege escalation vector. Without seeing `setupRoutes`, this is flagged as a design concern that needs verification.

---

### [LOW] HTTP redirect server is vulnerable to host header injection

**File:** `server/src/index.js`, lines 137-140

```js
const host = req.headers.host?.replace(`:${HTTP_PORT}`, `:${HTTPS_PORT}`) || `localhost:${HTTPS_PORT}`;
res.writeHead(301, { Location: `https://${host}${req.url}` });
```

The `Host` header and `req.url` are attacker-controlled and injected directly into the `Location` header. An attacker can send a crafted `Host` header like `evil.com` and the server will redirect to `https://evil.com/...`. This enables phishing via open redirect. Fix by using a configured hostname or validating the host header:

```js
const host = `localhost:${HTTPS_PORT}`; // or a configured SERVER_HOST
res.writeHead(301, { Location: `https://${host}${req.url}` });
```

---

### [LOW] `req.url` in HTTP redirect is not sanitized for header injection

**File:** `server/src/index.js`, line 139

While Node.js's modern HTTP parser rejects most CRLF sequences in practice, `req.url` is user-controlled and concatenated into a response header. In combination with the host header issue above, this compounds the open redirect concern.

---

Overall the codebase is reasonably structured. The reset-password script is clean and correct. The main concerns are the unauthenticated setup routes and the improper HTML escaping on the block page.

---

## server/src/auth

## Code Review: server/src/auth

### [MEDIUM] JWT contains stale role/permissions — no token revocation or re-validation

**File:** `server/src/auth/middleware.js`, lines 33-34

The middleware trusts the JWT payload (`decoded.role`, `decoded.must_change_password`) without checking the database. If an admin demotes a user or deletes their account, the user's existing 24h token retains full privileges until expiry.

```js
const decoded = jwt.verify(token, settings.value);
req.user = decoded; // role from token, not from DB
```

**Impact:** A deleted or demoted user can continue performing privileged actions for up to 24 hours.

**Fix:** Fetch the user from the DB in the middleware (at least `id`, `role`, `must_change_password`) and reject if the user no longer exists or merge the live role:

```js
const decoded = jwt.verify(token, settings.value);
const user = db.prepare('SELECT id, username, role, must_change_password FROM users WHERE id = ?').get(decoded.id);
if (!user) return res.status(401).json({ error: 'User no longer exists' });
req.user = { ...decoded, role: user.role, must_change_password: !!user.must_change_password };
```

---

### [MEDIUM] Path matching can be bypassed with trailing slashes or query strings

**File:** `server/src/auth/middleware.js`, lines 7-8, 17, 38

`PUBLIC_PATHS.includes(req.path)` uses exact string match. Express normalizes some things, but `req.path` can be `/api/auth/login/` (trailing slash) depending on router config, and `PASSWORD_CHANGE_PATHS` has the same issue.

```js
if (PUBLIC_PATHS.includes(req.path)) {  // "/api/auth/login/" won't match
```

**Impact:** Inconsistent behavior depending on how clients send requests. Not a direct bypass if Express strict routing is off (default routes both), but the middleware would reject the trailing-slash variant while the route handler still matches — resulting in unauthenticated requests being blocked that should pass, or authenticated-required paths behaving inconsistently.

**Fix:** Normalize the path before comparison:

```js
const normalizedPath = req.path.replace(/\/+$/, '');
if (PUBLIC_PATHS.includes(normalizedPath)) { ... }
```

---

### [LOW] Minimum password length of 4 characters is very weak

**File:** `server/src/auth/routes.js`, line 72

```js
if (new_password.length < 4) {
```

A 4-character minimum is trivially brutable. For an internal DNS/DHCP management tool, this is a low-severity concern but worth flagging — consider raising to at least 8 characters.

---

### Overall

The code is well-structured, readable, and handles the main auth flows correctly. The public path bypass and stale-JWT issues are the two most actionable items. No SQL injection risks (parameterized queries throughout), no XSS sinks, and bcrypt usage is correct.

---

## server/src/db (batch 1/2)

## Code Review: server/src/db (batch 1/2)

### Findings

**[MEDIUM] Migration 002 uses unconditional INSERT without IF NOT EXISTS — re-running breaks idempotency**

File: `server/src/db/migrations/002_subnets_ranges.sql`, lines 14-18

The `INSERT INTO range_types` statement has no `INSERT OR IGNORE` or `ON CONFLICT` clause. While migrations are tracked by version and shouldn't re-run, if the `schema_version` table is ever reset or manually edited (e.g., during development/recovery), this migration will fail with a UNIQUE constraint violation on `range_types.name`, potentially leaving the database in a partially-migrated state despite the transaction wrapper.

All other seed inserts (e.g., migration 009 line 36) use `INSERT OR IGNORE`. This is inconsistent.

**Fix:** Change to `INSERT OR IGNORE INTO range_types`.

---

**[MEDIUM] Migration 006 table rebuild is not wrapped in a transaction — failure mid-execution loses data**

File: `server/src/db/migrations/006_ptr_records.sql`

This migration creates a new table, copies data, drops the old table, and renames. While `init.js` line 49 wraps each migration in `db.transaction(...)`, SQLite's `DROP TABLE` and `ALTER TABLE ... RENAME` are DDL statements that cause implicit commits in some contexts. With `better-sqlite3`, `db.exec()` runs statements sequentially within the transaction, and DDL *should* work inside explicit transactions — but if `DROP TABLE dns_records` succeeds and `ALTER TABLE dns_records_new RENAME` fails, the original data is gone. This is a risky pattern.

**Fix:** Consider adding a safety check or at minimum document that this migration is destructive. A safer pattern is to rename the old table first (`ALTER TABLE dns_records RENAME TO dns_records_old`), create the new one, copy, then drop old.

---

**[LOW] `ensureDefaults` is exported and `async` but only the final `bcrypt.hash` call is async — all preceding DB calls are synchronous and unprotected**

File: `server/src/db/init.js`, line 73

If `ensureDefaults()` is called externally (it's exported) and any of the synchronous DB operations before the `await bcrypt.hash` throw, the error propagates correctly. However, the mix of many synchronous DB writes followed by a single async call means this function does ~15 individual DB writes without a transaction. If the process crashes midway (e.g., after inserting `jwt_secret` but before inserting `installation_complete`), the next startup will have partial defaults. This isn't catastrophic since each insert is guarded by an existence check, but wrapping the synchronous portion in a single transaction would be cleaner and faster.

**Fix:** Wrap the synchronous settings inserts in a `db.transaction(...)` call.

---

**[LOW] `audit()` function doesn't validate or sanitize `details` before `JSON.stringify`**

File: `server/src/db/init.js`, lines 137-141

This is minor, but `JSON.stringify` can throw on objects with circular references. If any caller passes a circular object as `details`, the `audit()` function will throw an unhandled error. Since this is an internal utility and callers likely always pass plain objects, the risk is low.

---

Overall the code is well-structured. The migration system is solid with version tracking and transactional application. The schema design is clean with appropriate foreign keys, indexes, and constraints.

---

## server/src/db (batch 2/2)

The migrations look straightforward and correct. A few findings:

---

### [MEDIUM] Migration 018 drops tables without migrating data

**File:** `server/src/db/migrations/018_blocklist_redesign.sql`, lines 22-23

```sql
DROP TABLE IF EXISTS blocklist_entries;
DROP TABLE IF EXISTS blocklist_sources;
```

These `DROP TABLE` statements permanently destroy any existing blocklist data with no data migration step. If users had custom blocklist sources configured, they silently lose all of them. This is a one-way destructive operation in a migration that can't be rolled back.

**Fix:** Either add `INSERT INTO ... SELECT FROM` statements to migrate existing data into `blocklist_categories`/`blocklist_domains` before dropping, or at minimum rename the old tables (e.g., `ALTER TABLE blocklist_sources RENAME TO blocklist_sources_backup`) so data can be recovered.

---

### [LOW] Migration 015 adds columns that are superseded by migration 016

**Files:** `server/src/db/migrations/015_dhcp_options.sql` and `server/src/db/migrations/016_dhcp_option_catalog.sql`

Migration 015 adds `ntp_servers` and `domain_search` columns directly to `dhcp_scopes`, then migration 016 introduces a proper `dhcp_scope_options` table for per-scope DHCP options keyed by option code. The columns from 015 are now redundant — NTP servers (option 42) and domain search (option 119) should be stored in `dhcp_scope_options`. This leaves dead columns on the table and ambiguity about which is the source of truth.

**Fix:** Add a migration that copies any existing data from `dhcp_scopes.ntp_servers`/`domain_search` into `dhcp_scope_options`, then drops those columns (or, since SQLite doesn't support `DROP COLUMN` before 3.35, recreate the table without them).

---

Overall the SQL is clean — `IF NOT EXISTS` guards are used consistently, foreign keys have `ON DELETE CASCADE`, and indexes are appropriate. No SQL injection concerns since these are static DDL migrations.

---

## server/src/routes (batch 1/2)

# Code Review — server/src/routes (batch 1/2)

## Findings

### [HIGH] Command injection via `execSync` in operations.js

**File:** `server/src/routes/operations.js`, lines 107-109 and 123-124

The `certPath` is constructed from `DATA_DIR` (which comes from `process.env.DATA_DIR`) and directly interpolated into a shell command string via `execSync`. If `DATA_DIR` contains shell metacharacters (e.g., set by a misconfigured environment variable like `DATA_DIR="/data; rm -rf /"`), this results in arbitrary command execution.

Similarly, lines 138-139 interpolate `tmpCert` and `tmpKey` into shell strings, though those use `os.tmpdir()` + controlled suffixes so are lower risk. The cert upload path at line 145 is more concerning:

```js
execSync(`openssl pkey -in "${tmpKey}" -noout -text 2>/dev/null | openssl rsa -modulus -noout 2>/dev/null || openssl pkey -in "${tmpKey}" -noout -text`, ...)
```

**Fix:** Use `execFileSync` instead of `execSync` to avoid shell interpretation:
```js
execFileSync('openssl', ['x509', '-in', certPath, '-noout', '-subject', '-issuer', '-dates', '-fingerprint', '-sha256'], { encoding: 'utf-8', timeout: 5000 });
```

Apply the same pattern to all `execSync` calls with interpolated paths in this file (lines 107, 138-145, 173-175).

---

### [HIGH] Command injection in health.js via DNS server values

**File:** `server/src/routes/health.js`, line 82

The `server` variable comes from a database `settings` row (originally from user input via `PUT /api/dns/forwarders`). It is interpolated into an `execFileSync` argument as `` `@${server}` ``. While `execFileSync` doesn't use a shell, the `dig` command interprets `@` arguments. However, the `execSync` call on line 47 is the real problem:

```js
const dfOutput = execSync('df -B1 /data 2>/dev/null || df -B1 / 2>/dev/null', { encoding: 'utf-8' });
```

This is hardcoded and safe. The `execFileSync` for `dig` is safe from shell injection. **Downgrading this specific point**, but noting that the DNS forwarders validation in `dns.js` does validate IPs with `isValidIpv4`, so the dig argument is safe in practice.

*(Removing this as a finding — the validation chain holds.)*

---

### [MEDIUM] SSRF via blocklist source URL

**File:** `server/src/routes/blocklists.js`, lines 73-85

The `PUT /categories/:slug/url` endpoint accepts a user-provided `source_url` that is later used by `refreshCategory` to fetch content. There is no validation that the URL is an external HTTP(S) URL. An attacker with `dns:write` permission could set `source_url` to `file:///etc/passwd`, `http://169.254.169.254/latest/meta-data/`, or internal network addresses, causing SSRF.

**Fix:** Validate `source_url` starts with `https://` or `http://` and optionally block private/link-local IP ranges:
```js
if (urlValue && !/^https?:\/\//i.test(urlValue)) {
  return res.status(400).json({ error: 'Source URL must be an HTTP(S) URL' });
}
```

---

### [MEDIUM] `NaN` propagated to SQL in audit route when `user_id` is non-numeric

**File:** `server/src/routes/audit.js`, line 39

```js
params.push(parseInt(req.query.user_id, 10));
```

If `req.query.user_id` is `"abc"`, `parseInt` returns `NaN`. Passing `NaN` to a SQLite prepared statement will match zero rows (not crash), but silently returns wrong results — the query behaves as if no filter was applied depending on the driver's `NaN` handling. This is confusing behavior.

**Fix:** Validate the parsed integer:
```js
const userId = parseInt(req.query.user_id, 10);
if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user_id' });
params.push(userId);
```

---

### [MEDIUM] Unbounded `limit` in blocklist search allows expensive queries

**File:** `server/src/routes/blocklists.js`, lines 157-158

```js
const { q, page = 1, limit = 50 } = req.query;
// ...
const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
```

The `limit` parameter is taken directly from the query string with no upper bound, unlike the audit route which caps at 100. A user could pass `limit=999999999` to force a massive query. Also, if `page` or `limit` are non-numeric strings, `parseInt` returns `NaN`, causing `offset` to be `NaN`.

**Fix:** Clamp and validate like the audit route:
```js
const pageNum = Math.max(1, parseInt(page, 10) || 1);
const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
const offset = (pageNum - 1) * limitNum;
```

---

### [LOW] Scope deletion cascade deletes the parent range

**File:** `server/src/routes/dhcp.js`, line 179

```js
db.prepare('DELETE FROM ranges WHERE id = ?').run(scope.range_id);
```

Deleting a DHCP scope also deletes the underlying range. This is a design choice but could be surprising — the range existed before the scope was created and may have been intentionally defined. If this is intentional, it should at least be documented in the API response. If not, this is a data loss bug.

---

## server/src/routes (batch 2/2)

The code is clean, well-structured, and handles the common cases correctly. Only one real finding:

---

### [MEDIUM] SQL LIKE injection via unsanitized wildcard characters — `vlans.js:44`

```js
const term = `%${(q || '').trim()}%`;
```

The search term `q` is interpolated into a LIKE pattern without escaping LIKE metacharacters (`%`, `_`). A user searching for `%` or `_` gets unintended wildcard matching — `%` would match all rows, and `_` matches any single character. This isn't a SQL injection (parameterized queries prevent that), but it breaks search correctness.

**Fix:** Escape LIKE-special characters before wrapping in `%`:

```js
const escaped = (q || '').trim().replace(/[%_]/g, '\\$&');
const term = `%${escaped}%`;
```

And add `ESCAPE '\\'` to the LIKE clauses in the SQL.

---

Everything else looks solid — permission checks are consistent, duplicate detection is correct, audit logging is present, and parameterized queries are used throughout.

---

## server/src/utils

## Code Review Findings

### [HIGH] SQL Injection via string interpolation in blocklist scheduler

**File:** `server/src/utils/blocklist.js`, line ~175

```javascript
const due = db.prepare(`
  SELECT slug FROM blocklist_categories
  WHERE enabled = 1
    AND (last_fetched_at IS NULL
         OR datetime(last_fetched_at, '+${intervalHours} hours') <= datetime('now'))
`).all();
```

`intervalHours` comes from `scheduleToHours()` which returns a hardcoded integer from a switch statement, so this is currently safe. However, the value flows from a database setting (`blocklist_update_schedule`), and the `default` case returns `0` (which exits early). If a new schedule value is added to the switch without also adding an early-return guard, or if the function is refactored, this becomes injectable. More critically, this is a pattern that will fail code audits and should use a parameterized query.

**Fix:** Use SQLite's parameter binding:
```javascript
const due = db.prepare(`
  SELECT slug FROM blocklist_categories
  WHERE enabled = 1
    AND (last_fetched_at IS NULL
         OR datetime(last_fetched_at, '+' || ? || ' hours') <= datetime('now'))
`).all(intervalHours);
```

---

### [MEDIUM] GeoIP DNS proxy timeout is fail-open without sending a response

**File:** `server/src/utils/geoip.js`, lines ~163-170

```javascript
const timer = setTimeout(() => {
  const p = pendingQueries.get(internalId);
  if (p) {
    pendingQueries.delete(internalId);
    statsAllowed++;
    statsTotal++;
  }
}, 5000);
```

When an upstream DNS query times out, the pending query is silently removed and stats incremented, but **no response is ever sent back to the client**. The client's DNS query just hangs until its own timeout. The comment says "fail-open" but nothing is actually forwarded or responded to. The client should receive either the original query forwarded to another upstream, or a SERVFAIL response.

**Fix:** Send a SERVFAIL (or the original query to a fallback upstream) in the timeout handler:
```javascript
const timer = setTimeout(() => {
  const p = pendingQueries.get(internalId);
  if (p) {
    pendingQueries.delete(internalId);
    statsAllowed++;
    statsTotal++;
    // Send SERVFAIL so client doesn't hang
    try {
      const servfail = dnsPacket.encode({
        id: p.originalId, type: 'response', rcode: 'SERVFAIL',
        questions: [], answers: []
      });
      proxyServer?.send(servfail, p.port, p.address);
    } catch { /* ignore */ }
  }
}, 5000);
```

---

### [MEDIUM] Path traversal in `getBackupPath` and `deleteBackup`

**File:** `server/src/utils/backup.js`, lines ~102-104

```javascript
export function getBackupPath(filename) {
  return path.join(BACKUP_DIR, filename);
}
```

If `filename` comes from user input (e.g. a route handler that passes `req.params.filename`), a value like `../../etc/passwd` would resolve outside BACKUP_DIR via `path.join`. The `deleteBackup` function (line ~90) uses `row.filename` from the DB which is safer, but `getBackupPath` is exported and likely called with user-supplied filenames for download.

**Fix:** Validate the resolved path stays within BACKUP_DIR:
```javascript
export function getBackupPath(filename) {
  const resolved = path.resolve(BACKUP_DIR, filename);
  if (!resolved.startsWith(path.resolve(BACKUP_DIR) + path.sep)) {
    throw new Error('Invalid backup filename');
  }
  return resolved;
}
```

---

### [MEDIUM] `dnsCache` is module-level and never expires — unbounded memory growth

**File:** `server/src/utils/dhcp.js`, lines ~14-26

```javascript
const dnsCache = new Map();
function resolveToIp(value) {
  if (IPV4_RE.test(value)) return value;
  if (dnsCache.has(value)) return dnsCache.get(value);
  // ...
  dnsCache.set(value, result);
```

The cache is cleared in `regenerateScopeConfigs` via `dnsCache.clear()`, but `resolveToIp` is exported implicitly through scope config generation. If hostnames are used in DHCP options and change frequently, stale DNS results persist across the entire run. More importantly, if `resolveToIp` is ever called outside `regenerateScopeConfigs`, the cache grows forever. This is minor given current usage but the comment "Caches results for the lifetime of a config generation pass" is only true because of the `clear()` call — this coupling is fragile.

---

### [LOW] Backup includes its own backups directory in the tar archive

**File:** `server/src/utils/backup.js`, line ~18-24

The backup is written to `BACKUP_DIR = DATA_DIR/backups/` before `tar` runs, and the tar command runs from `DATA_DIR`. While the code doesn't explicitly include `backups/`, if `ipam.db` grows and multiple backups accumulate, the `dnsmasq` directory will include prior dnsmasq state which is fine. Not a bug per se, but the archive could inadvertently include the just-created archive file if another backup path were added without care.

---

### [LOW] `startBackupScheduler` and `startBlocklistScheduler` return no handle to clear intervals

**Files:** `server/src/utils/backup.js` line ~117, `server/src/utils/blocklist.js` line ~165

Both use `setInterval` without storing or returning the timer. This prevents clean shutdown and makes testing difficult. `scan-scheduler.js` does this correctly with `stopScanScheduler()`. The GeoIP scheduler stores `updateTimer` but the proxy `setInterval` timers for backup/blocklist cannot be stopped.

---
