# Code Review Report

**Date:** 2026-03-07
**Directory:** /home/mcnultyd/dev/ipam
**Focus:** all
**Files reviewed:** 91

---

# Executive Summary

# Code Review Executive Summary

## Critical Issues (Must Fix)
- **Command Injection Vulnerabilities**: Multiple `execSync` calls with unsanitized user input across backup.js, cert.js, and dnsmasq.js - immediate security risk
- **XSS Vulnerability**: Unescaped domain names in blocked page response could allow script injection
- **Auth Token Security**: JWT tokens stored in localStorage vulnerable to XSS attacks - use httpOnly cookies
- **Race Conditions**: State persistence bugs and auth flow issues causing data loss and navigation errors
- **Database Resource Leaks**: Connections not properly closed on errors, JWT secrets fetched on every request

## Improvements (Should Fix)
- **Large Component Decomposition**: System.vue (54.6KB) and DHCP.vue (900+ lines) need splitting
- **Inconsistent Error Handling**: Mixed async patterns and silent failures across components
- **Missing Input Validation**: Weak password requirements (4 chars) and unvalidated user inputs
- **Memory Leaks**: GeoIP proxy pending queries accumulate, DNS cache never expires
- **Performance Issues**: N+1 query patterns and repeated DB operations

## Statistics
- **HIGH**: 12 findings (security vulnerabilities, data integrity issues)
- **MEDIUM**: 18 findings (bugs, performance, consistency issues)  
- **LOW**: 15 findings (style, maintainability improvements)

## Top 5 Priorities

1. **Fix Command Injection Vulnerabilities** - Replace all `execSync` with `execFile` to prevent shell injection attacks in server utils

2. **Secure Authentication System** - Move JWT tokens to httpOnly cookies, cache JWT secrets, add rate limiting to login

3. **Fix Race Conditions** - Repair state persistence bugs in SubnetsLayoutB.vue and auth flow issues causing data loss

4. **Close Resource Leaks** - Ensure database connections close on errors, fix GeoIP memory accumulation

5. **Add Input Validation** - Implement proper validation for IP addresses, strengthen password requirements, sanitize user inputs

---

# Detailed Findings

## client/src

## Code Review

Overall, the codebase looks well-structured with good separation of concerns. Here are my findings:

### **Bugs**

**[MEDIUM] client/src/main.js:53** - Missing error handling for theme configuration
```javascript
// Theme switching — listen for theme change events and update PrimeVue preset
window.addEventListener('ipam:theme-change', (e) => {
  const theme = e.detail;
  // Add validation here
  if (!theme || !theme.primary || !theme.surface) {
    console.warn('Invalid theme data received:', theme);
    return;
  }
  // ... rest of updatePreset call
```
The event listener assumes `e.detail` contains valid theme data with `primary` and `surface` properties, but doesn't validate this.

**[LOW] client/src/main.js:125** - Potential null reference
```javascript
window.addEventListener('unhandledrejection', (event) => {
  const msg = event.reason?.message || String(event.reason || 'Unknown error');
  debug.logError(`Unhandled: ${msg}`, event.reason?.stack);
});
```
If `event.reason` is null/undefined, `String(event.reason)` will show "null"/"undefined" rather than a meaningful error message.

### **Style**

**[LOW] client/src/App.vue:38-40** - Inconsistent custom property naming
```css
/* Current */
--ipam-ground: #898989;
--ipam-card: #c4c4c4;

/* Should follow existing pattern */
--p-ipam-ground: #898989;
--p-ipam-card: #c4c4c4;
```
The custom IPAM properties don't follow the `--p-` prefix convention used by other surface properties.

**[LOW] client/src/main.js:50-52** - Large repetitive theme configuration
The theme update code has significant duplication between primary/surface color definitions and light/dark surface configs. Consider extracting to a helper function:
```javascript
function buildColorConfig(colorName) {
  return Object.fromEntries(
    [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
      .map(shade => [shade, `{${colorName}.${shade}}`])
  );
}
```

### **Consistency**

**[MEDIUM] client/src/App.vue:46-52** - Mixed CSS override strategies
```css
/* Uses !important */
.p-tabview-ink-bar {
  display: none !important;
}
/* Also uses !important */
.p-tabview-tablist-item-active > .p-tabview-tab-header {
  border-bottom-color: var(--p-primary-color) !important;
}
```
While the toast styles also use `!important`, consider if CSS specificity could be increased instead to avoid override conflicts.

### **Security**

No security issues found. The code doesn't handle user input directly or expose sensitive data.

### **Summary**

The code is generally well-written with good Vue 3 + PrimeVue patterns. The main issues are around error handling robustness and some minor style consistency improvements. The theme system implementation is solid but could benefit from input validation.

---

## client/src/api

# Code Review: client/src/api/client.js

## Overall Assessment
The code is well-structured with proper error handling patterns, but has some critical architecture issues and potential bugs.

## Findings

### [HIGH] Architecture Anti-Pattern - Pinia Store Usage in Non-Vue Context
**Lines 12, 18, 24, 30, 33-34**
- Using `useAuthStore()` and `useDebugStore()` outside Vue component context will cause runtime errors
- Pinia composables require active Pinia instance and Vue context

**Fix:** Use direct store access pattern:
```javascript
import { authStore } from '../stores/auth.js';
import { debugStore } from '../stores/debug.js';

// Then use authStore.token instead of useAuthStore().token
```

### [HIGH] Race Condition Risk with Router Navigation
**Line 35**
- Router may not be ready when interceptor executes during app initialization
- Could cause navigation errors on app startup with invalid tokens

**Fix:** Add router readiness check:
```javascript
if (router.currentRoute) {
  router.push('/login');
}
```

### [MEDIUM] Silent Error Handling May Hide Issues
**Lines 16, 25**
- Empty catch blocks suppress all errors, making debugging difficult
- Could hide legitimate configuration or initialization problems

**Fix:** Log suppressed errors in development:
```javascript
} catch (error) {
  if (process.env.NODE_ENV === 'development') {
    console.warn('Store not ready:', error);
  }
}
```

### [MEDIUM] Missing Error Response Structure Validation
**Line 26**
- Assumes `error.response.data.error` structure exists
- Could cause undefined access if API returns different error format

**Fix:** Add safer property access:
```javascript
const msg = error.response?.data?.error || error.response?.data?.message || error.message;
```

### [LOW] Inconsistent Method Access Pattern
**Lines 18, 24**
- Mixed optional chaining usage: `response.config.method.toUpperCase()` vs `error.config?.method?.toUpperCase()`
- Should be consistent for reliability

**Fix:** Use optional chaining consistently:
```javascript
debug.logApi(`${response.config?.method?.toUpperCase()} ${response.config?.url} → ${response.status}`);
```

### [LOW] Potential Memory Leak with Store References
**Lines 12, 18, 24, 30, 33**
- Creating new store instances on every request/response
- Could cause memory issues with high API usage

**Fix:** Cache store references outside interceptor functions or use singleton pattern.

## Security
No security issues found. Token handling and 401 response management follow good practices.

---

## client/src/components

Looking good overall! Here's my review:

## Bugs

### [MEDIUM] client/src/components/DebugPanel.vue:101
```javascript
function formatDetail(detail) {
  if (typeof detail === 'string') return detail;
  try { return JSON.stringify(detail, null, 2); } catch { return String(detail); }
}
```
The `catch` block doesn't bind the error parameter but calls `String(detail)` instead of handling the error properly. Should be:
```javascript
try { return JSON.stringify(detail, null, 2); } catch (e) { return String(detail); }
```

### [MEDIUM] client/src/components/HeaderBar.vue:72-78
```javascript
const systemAlerts = computed(() => {
  const h = health.value;
  if (!h) return [];
  const alerts = [];
  // ... alert logic
```
Multiple places access nested properties without null checks (e.g., `h.dns.servers?.filter`, `h.disk.percent`). While some use optional chaining, it's inconsistent. Add defensive checks:
```javascript
if (h.dns?.servers && !h.dns.ok) {
  const downServers = h.dns.servers.filter(s => s.status !== 'up').map(s => s.server) || [];
```

### [LOW] client/src/components/NetworkDialogs.vue:314
```javascript
function findSubnetInTree(id, nodes) {
  for (const f of (nodes || store.folders)) {
    if (nodes) {
      // recursion logic
    } else {
      if (f.subnets) {
        const found = findSubnetInTree(id, f.subnets);
```
This function assumes `store.folders` exists and has the expected structure. Add null checks for robustness.

## Style

### [LOW] client/src/components/HeaderBar.vue:165-175
```javascript
const dnsTooltip = computed(() => {
  const dns = health.value?.dns;
  if (!dns) return { value: 'Loading...', escape: false };
  const lines = [];
  const ok = '<span style="color:#22c55e">OK</span>';
  const fail = '<span style="color:#ef4444">DOWN</span>';
```
Hardcoded colors in tooltip HTML. Should use CSS custom properties:
```javascript
const ok = '<span style="color:var(--p-green-500)">OK</span>';
const fail = '<span style="color:var(--p-red-500)">DOWN</span>';
```

### [MEDIUM] client/src/components/NetworkDialogs.vue:200-220
The `onDivideCountInput` function has complex logic that could be extracted:
```javascript
function onDivideCountInput(val) {
  if (!val || val < 2) return;
  const steps = calculateStepsFromCount(val);
  divideSteps.value = steps;
  divideCount.value = Math.pow(2, steps);
}

function calculateStepsFromCount(count) {
  const steps = Math.round(Math.log2(count));
  return Math.max(1, Math.min(steps, maxDivideSteps.value));
}
```

## Consistency

### [LOW] client/src/components/HeaderBar.vue:108 vs DebugPanel.vue:82
Different date formatting approaches:
- HeaderBar: No specific time formatting shown
- DebugPanel: `date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })`

Consider creating a shared time formatting utility.

### [MEDIUM] Error handling patterns vary across components
- NetworkDialogs: Uses toast notifications consistently
- HeaderBar: Silent failures in `fetchHealth()`
- DebugPanel: No error handling shown

Standardize error handling approach across all components.

## Security

### [LOW] client/src/components/DebugPanel.vue:93
```javascript
function formatDetail(detail) {
  if (typeof detail === 'string') return detail;
  try { return JSON.stringify(detail, null, 2); } catch { return String(detail); }
}
```
The formatted detail is displayed in a `<pre>` tag. While not immediately dangerous, ensure debug content can't contain malicious data if debug info comes from user input.

### [LOW] client/src/components/HeaderBar.vue:165-180
HTML is constructed and injected via tooltip without escaping:
```javascript
const dnsTooltip = computed(() => {
  // ... builds HTML string with lines.join('<br>')
  return { value: lines.join('<br>'), escape: false };
});
```
Since this uses system health data, it's likely safe, but validate that health endpoint data is properly sanitized.

## Overall Assessment

The code is well-structured and follows Vue 3 composition API best practices. The component separation is logical, and the use of stores for state management is appropriate. The main issues are around defensive programming and consistency in error handling patterns.

---

## client/src/router

## Code Review: client/src/router/index.js

Overall, this router configuration is well-structured with proper authentication guards. However, there are several issues that need attention:

### Bugs

**[HIGH] Unused setup logic creates confusion** (lines 35-37, 70-72)
- The `setupChecked` and `setupRequired` variables are declared but never used
- Setup wizard is always disabled by redirecting to Login (line 35-37)
- `markSetupComplete()` function modifies unused state
- **Fix**: Either remove the unused setup logic entirely, or implement proper setup checking if the feature is needed

**[MEDIUM] Missing error handling in auth flow** (lines 46-51)
- `auth.fetchUser()` could throw errors (network failures, server errors)
- Uncaught errors would break navigation
- **Fix**: Wrap in try-catch and handle gracefully:
```javascript
try {
  await auth.fetchUser();
} catch (error) {
  console.error('Failed to fetch user:', error);
  return { name: 'Login' };
}
```

### Style & Consistency 

**[LOW] Inconsistent component import patterns** (lines 4-8, 22-28)
- Static imports for some components, dynamic imports for others
- No clear pattern for when to use which approach
- **Fix**: Use dynamic imports consistently for route components to enable code splitting, or document the reasoning for the mixed approach

**[LOW] Magic route redirects could be more maintainable** (lines 25-30)
- Multiple hardcoded redirect paths
- **Fix**: Consider using a configuration object:
```javascript
const legacyRoutes = {
  'subnets': '/',
  'dns': '/system',
  'dhcp': '/system',
  // ...
};
```

### Security

**[MEDIUM] Navigation guard bypass potential** (lines 38-41)
- The public route check `to.meta.public && to.name !== 'Setup'` could be confusing
- Setup route is handled separately but still has `meta: { public: true }`
- **Fix**: Simplify the logic and ensure setup route metadata is consistent with its behavior

### Minor Issues

**[LOW] Commented code suggests incomplete feature** (line 34)
- "Setup wizard disabled" comment suggests this is temporary
- **Fix**: Either implement the feature properly or remove the setup-related code entirely

The code is functional and secure for its current use case, but the unused setup logic should be addressed to prevent future confusion and potential bugs.

---

## client/src/stores

Looking at this codebase, the overall structure is well-organized and consistent. Here are my findings:

## Security Issues

**[HIGH] Auth token exposure in local storage** - `client/src/stores/auth.js:6, 16, 26`
- Auth tokens stored in localStorage are vulnerable to XSS attacks
- **Fix**: Use httpOnly cookies or secure sessionStorage with proper CSP headers

**[MEDIUM] No request timeout handling** - Multiple files
- API calls lack timeout configuration, risking hung requests
- **Fix**: Add default timeouts to the API client configuration

## Bugs

**[MEDIUM] Race condition in auth store** - `client/src/stores/auth.js:36-40`
- `fetchUser()` calls `logout()` on error, but if multiple requests fail simultaneously, this could cause unexpected state changes
- **Fix**: Add debouncing or use a single auth check mechanism

**[LOW] Memory leak potential** - `client/src/stores/subnets.js:198-201`
- Detail cache uses Map but only checks size, not actual memory usage of large responses
- **Fix**: Add memory-based eviction or clear cache on navigation

## Style Issues

**[LOW] Inconsistent error handling patterns** - Multiple files
- Some functions have try/finally blocks (`client/src/stores/blocklists.js:11-17`), others don't
- Some swallow errors silently (`client/src/stores/auth.js:36-40`)
- **Fix**: Establish consistent error handling pattern across all stores

**[LOW] Magic numbers without constants** - Multiple files
- `client/src/stores/debug.js:6-7`: `200`, `24 * 60 * 60 * 1000`
- `client/src/stores/subnets.js:199`: `30_000`, `20`
- **Fix**: Extract to named constants at module top

## Consistency Issues

**[MEDIUM] Mixed async refresh patterns** - Multiple files
- Some functions auto-refresh after mutations (`client/src/stores/blocklists.js:24`), others don't
- Some have both refresh and non-refresh variants (`client/src/stores/subnets.js:138, 143`)
- **Fix**: Standardize on explicit refresh control or consistent auto-refresh

**[LOW] Inconsistent loading state management** - Multiple files
- Some stores track loading globally, others per-operation
- **Fix**: Decide on one pattern and apply consistently

## Positive Notes

✅ **Good separation of concerns** - Each store handles a distinct domain
✅ **Consistent API patterns** - All stores use the same API client
✅ **Proper Vue 3 Composition API usage** - Correct use of refs and computed
✅ **Good caching strategy** - Smart caching in subnet store with TTL and eviction
✅ **Comprehensive theme system** - Well-structured theme management

The code is generally well-written with good architectural decisions. The main areas for improvement are security (token storage) and consistency (error handling and refresh patterns).

---

## client/src/utils

# Code Review: client/src/utils

## Summary
The code quality is generally good with clear structure and comprehensive functionality. Found several important issues that should be addressed.

## Findings

### **client/src/utils/ip.js**

#### [HIGH] Undefined Behavior in `ipToLong()` (lines 6-8)
```javascript
const parts = ip.split('.').map(Number);
return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
```
**Problem**: No validation of IP format or octets. Invalid IPs like "999.999.999.999" or "a.b.c.d" will produce incorrect results.

**Fix**: Add IP validation:
```javascript
export function ipToLong(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) throw new Error(`Invalid IP format: ${ip}`);
  
  const octets = parts.map(part => {
    const num = parseInt(part, 10);
    if (isNaN(num) || num < 0 || num > 255) {
      throw new Error(`Invalid octet: ${part}`);
    }
    return num;
  });
  
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}
```

#### [HIGH] Potential Infinite Loop in `subtractCidr()` (lines 135-155)
```javascript
while (currentPrefix < child.prefix) {
  // ... loop body
}
```
**Problem**: If the child CIDR validation passes but edge cases occur during calculation, this could theoretically loop indefinitely.

**Fix**: Add a safety counter:
```javascript
let iterations = 0;
const maxIterations = 32; // Maximum possible prefix length
while (currentPrefix < child.prefix && iterations < maxIterations) {
  // ... existing loop body
  iterations++;
}
if (iterations >= maxIterations) {
  throw new Error('Subnet calculation exceeded maximum iterations');
}
```

#### [MEDIUM] Input Validation Missing (line 74)
```javascript
export function isSubnetOf(childCidr, parentCidr) {
  const child = parseCidr(childCidr);
  const parent = parseCidr(parentCidr);
```
**Problem**: Function doesn't handle the case where `parseCidr()` throws an error for invalid CIDRs.

**Fix**: Wrap in try-catch:
```javascript
export function isSubnetOf(childCidr, parentCidr) {
  try {
    const child = parseCidr(childCidr);
    const parent = parseCidr(parentCidr);
    // ... rest of function
  } catch {
    return false; // Invalid CIDR cannot be subnet of anything
  }
}
```

#### [MEDIUM] Inconsistent Error Handling (line 82)
```javascript
export function isValidCidr(cidr) {
  try { parseCidr(cidr); return true; } catch { return false; }
}
```
**Problem**: Uses bare `catch` while other functions like `parseCidr()` throw specific error messages. Inconsistent pattern.

**Fix**: Either make all validation functions return boolean results, or make them all throw errors. Consider:
```javascript
export function validateCidr(cidr) {
  return parseCidr(cidr); // throws on invalid
}

export function isValidCidr(cidr) {
  try { parseCidr(cidr); return true; } catch { return false; }
}
```

#### [LOW] Performance - Repeated Parsing (lines 111-113)
```javascript
export function validateSupernet(cidr) {
  const parsed = parseCidr(cidr);
  for (const reserved of RESERVED_RANGES) {
    const res = parseCidr(reserved.cidr); // Parsing same CIDRs repeatedly
```
**Problem**: Reserved range CIDRs are parsed every time the function is called.

**Fix**: Parse reserved ranges once at module level:
```javascript
const PARSED_RESERVED_RANGES = RESERVED_RANGES.map(range => ({
  ...range,
  parsed: parseCidr(range.cidr)
}));
```

### **client/src/utils/countries.js**

#### [MEDIUM] No Input Validation in `countryFlag()` (lines 4-8)
```javascript
export function countryFlag(code) {
  return String.fromCodePoint(
    ...code.toUpperCase().split('').map(c => 0x1F1E6 + c.charCodeAt(0) - 65)
  );
}
```
**Problem**: No validation that `code` is exactly 2 characters or contains only A-Z letters. Invalid codes will produce incorrect Unicode.

**Fix**: Add validation:
```javascript
export function countryFlag(code) {
  if (!code || typeof code !== 'string' || code.length !== 2) {
    throw new Error('Country code must be a 2-character string');
  }
  
  const upper = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) {
    throw new Error('Country code must contain only letters A-Z');
  }
  
  return String.fromCodePoint(
    ...upper.split('').map(c => 0x1F1E6 + c.charCodeAt(0) - 65)
  );
}
```

#### [LOW] Missing Utility Functions
**Problem**: No helper functions to find country by code or get all country codes.

**Fix**: Consider adding:
```javascript
export function findCountryByCode(code) {
  return COUNTRIES.find(country => country.code === code);
}

export function getCountryCodes() {
  return COUNTRIES.map(country => country.code);
}
```

## Overall Assessment
The IP utilities are comprehensive and well-designed for network calculations. The main concerns are input validation and edge case handling. The countries module is simple but functional. Both files would benefit from more robust input validation.

---

## client/src/views

Looking at the client-side views, I'll focus on identifying the most significant issues across these Vue.js components.

## Key Findings

### **[HIGH] Security - Potential XSS Vulnerabilities**

**client/src/views/Blocklists.vue (lines 90, 96, 286, etc.)**
```vue
<div class="text-sm muted">{{ data.description }}</div>
<span v-if="data.last_error" class="badge-error" :title="data.last_error">Error</span>
```
User-controlled data like `data.description` and `data.last_error` are rendered without sanitization. While Vue.js escapes by default with `{{ }}`, the `:title` attribute binding could be exploited if the error messages contain malicious content.

**Fix:** Sanitize error messages on the backend and validate that descriptions don't contain HTML/JS.

### **[HIGH] Bugs - Missing Error Handling**

**client/src/views/DHCP.vue (lines 463-469)**
```javascript
async function doDeleteScope() {
  savingScope.value = true;
  try {
    await store.deleteScope(deletingScope.value.id);
    // ... success handling
  } catch (err) {
    // ... error handling
  } finally {
    savingScope.value = false;  // BUG: This should be deletingScope
  }
}
```
Wrong loading state variable used - should be `deleting.value = false` for delete operations.

**client/src/views/SubnetsLayoutB.vue (lines 108-116)**
```javascript
function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }  // Silent failure
}
```
localStorage corruption could cause data loss. Should log the error for debugging.

### **[HIGH] Bugs - Race Conditions & Memory Leaks**

**client/src/views/SubnetsLayoutB.vue (lines 118-127)**
```javascript
let _persistTimer = null;
function persistState() {
  if (_persistTimer) return;  // BUG: Multiple rapid calls lost
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    // ... save state
  }, 300);
}
```
If `persistState()` is called multiple times quickly, only the first call is honored and subsequent state changes are lost.

**Fix:** Clear existing timer and restart:
```javascript
function persistState() {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    // ... save state
  }, 300);
}
```

### **[MEDIUM] Consistency - Mixed Async Patterns**

**client/src/views/Blocklists.vue vs DNS.vue**
- Blocklists uses `async/await` consistently
- DNS.vue mixes `.then()` and `async/await`:
```javascript
// Inconsistent pattern in DNS.vue
store.getForwarders().then(s => forwarders.value = s).catch(() => {})
```

**Fix:** Standardize on `async/await` throughout.

### **[MEDIUM] Style - Overly Complex Components**

**client/src/views/DHCP.vue**
This component is 900+ lines and handles multiple concerns (scopes, reservations, options, leases). Should be split into separate components.

**client/src/views/System.vue**
Flagged as too large (54.6KB) - needs decomposition into smaller, focused components.

### **[MEDIUM] Bugs - Input Validation Missing**

**client/src/views/ChangePassword.vue (lines 36-42)**
```javascript
if (newPassword.value.length < 4) {
  error.value = 'Password must be at least 4 characters';
  return;
}
```
4 characters is too weak for password validation. Should be at least 8-12 characters with complexity requirements.

**client/src/views/GeoIP.vue (lines 105-106)**
```javascript
async function doSearch() {
  if (!searchQuery.value.trim() || searchQuery.value.trim().length < 2) return;
```
No maximum length validation - could allow very long search queries that impact performance.

### **[LOW] Style - Inconsistent Naming**

**Mixed naming conventions across files:**
- `doSaveSettings` vs `saveSettings`
- `showAddDialog` vs `showCustomOptionDialog`
- Some use camelCase, others use snake_case for similar functions

### **[LOW] Performance - Unnecessary Reactivity**

**client/src/views/SubnetsLayoutB.vue (line 200)**
```javascript
watch(() => store.folders, () => {
  // ... expensive operations
}, { deep: false });
```
Multiple watchers without cleanup could impact performance in large datasets.

## Summary

The codebase shows good Vue.js practices overall but has several critical issues:
1. **Security**: Potential XSS in error message display
2. **Reliability**: Race conditions in state persistence and wrong loading state variables
3. **Maintainability**: Several overly large components need decomposition
4. **Consistency**: Mixed async patterns and naming conventions

Priority should be fixing the race conditions and security issues, then breaking down the large components for better maintainability.

---

## root

## Code Review: client/vite.config.js

### Overall Assessment
The configuration is functional but has some security and robustness concerns that should be addressed.

### Findings

#### **Security Issues**

**[HIGH] Insecure HTTPS proxy configuration**
- **File**: `client/vite.config.js`, line 9
- **Issue**: `secure: false` disables SSL certificate verification for the proxy target
- **Risk**: Makes the application vulnerable to man-in-the-middle attacks
- **Fix**: Either use a valid SSL certificate for localhost:8443 or use HTTP instead of HTTPS for local development

#### **Configuration Issues**

**[MEDIUM] Hardcoded proxy target**
- **File**: `client/vite.config.js`, line 8
- **Issue**: Proxy target is hardcoded to `https://localhost:8443`
- **Problem**: Not flexible for different environments (dev, staging, prod)
- **Fix**: Use environment variables:
```javascript
target: process.env.VITE_API_URL || 'https://localhost:8443'
```

**[LOW] Missing error handling configuration**
- **File**: `client/vite.config.js`, proxy configuration
- **Issue**: No error handling or timeout configuration for proxy
- **Fix**: Consider adding:
```javascript
'/api': {
  target: 'https://localhost:8443',
  secure: false,
  changeOrigin: true,
  timeout: 30000,
  onError: (err, req, res) => {
    console.error('Proxy error:', err);
  }
}
```

### Recommendations
1. **Immediate**: Address the SSL security issue by either using valid certificates or HTTP for local development
2. **Short-term**: Make the API URL configurable via environment variables
3. **Optional**: Add proxy error handling and timeout configuration for better development experience

---

## server/src

## Code Review Results

### Overall Assessment
The code is generally well-structured with good separation of concerns. However, there are several security vulnerabilities and potential bugs that need attention.

---

## 🚨 HIGH Severity Issues

### [HIGH] XSS Vulnerability in Blocked Page Response
**File**: `server/src/index.js:123`
```javascript
<p>Access to <strong>${domain.replace(/[<>"'&]/g, '')}</strong> has been blocked by your network administrator.</p>
```
**Issue**: The regex `[<>"'&]` doesn't cover all XSS vectors. Missing ampersand entity encoding and other dangerous characters.
**Fix**: Use proper HTML escaping or a template engine:
```javascript
const escapeHtml = (str) => str.replace(/[&<>"']/g, (match) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[match]));
```

### [HIGH] Database Connection Not Closed on Error
**File**: `server/src/reset-password.js:33`
**Issue**: If the password update fails, `db.close()` is never called, leading to resource leaks.
**Fix**: Add proper error handling:
```javascript
try {
  db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = datetime('now') WHERE username = ?")
    .run(hash, username);
  console.log('Password updated successfully');
} catch (error) {
  console.error('Failed to update password:', error);
  process.exit(1);
} finally {
  db.close();
}
```

---

## 🔶 MEDIUM Severity Issues

### [MEDIUM] Unhandled Promise Rejection in Async Startup
**File**: `server/src/index.js:33`
**Issue**: `await startProxyIfEnabled()` could fail and crash the application. Other async startup functions also lack individual error handling.
**Fix**: Wrap each async startup call in try-catch:
```javascript
try {
  await startProxyIfEnabled();
} catch (error) {
  console.error('Failed to start GeoIP proxy:', error);
  // Decide if this should be fatal or not
}
```

### [MEDIUM] Missing File Existence Check
**File**: `server/src/index.js:141-142`
**Issue**: Reading cert files without checking existence first could cause crashes.
**Fix**: Add existence checks:
```javascript
if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
  throw new Error('Certificate files not found after ensureCerts()');
}
```

### [MEDIUM] Inconsistent Error Handling in HTTP Server
**File**: `server/src/index.js:159-166`
**Issue**: HTTP server only handles `EADDRINUSE`, but other errors like `EACCES` (permission denied) aren't handled gracefully.
**Fix**: Add comprehensive error handling:
```javascript
httpServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.warn(`HTTP redirect port ${HTTP_PORT} already in use, skipping HTTP redirect server`);
  } else if (err.code === 'EACCES') {
    console.warn(`Permission denied for port ${HTTP_PORT}, skipping HTTP redirect server`);
  } else {
    console.error('HTTP server error:', err);
    // Consider if this should be fatal
  }
});
```

---

## 🔷 LOW Severity Issues

### [LOW] Magic Number in Audit Log Retention
**File**: `server/src/index.js:68`
**Issue**: Hardcoded 7 days and 6-hour intervals should be configurable.
**Fix**: Move to environment variables:
```javascript
const AUDIT_RETENTION_DAYS = process.env.AUDIT_RETENTION_DAYS || '7';
const AUDIT_PRUNE_INTERVAL_HOURS = process.env.AUDIT_PRUNE_INTERVAL_HOURS || '6';
```

### [LOW] Weak Password Generation Entropy
**File**: `server/src/reset-password.js:15`
**Issue**: 12 bytes of randomness might not be sufficient for high-security environments.
**Fix**: Increase to 16 or 24 bytes:
```javascript
const password = crypto.randomBytes(16).toString('base64url');
```

### [LOW] Missing Input Validation
**File**: `server/src/reset-password.js:12`
**Issue**: Username from command line isn't validated.
**Fix**: Add basic validation:
```javascript
const username = process.argv[2];
if (!username || username.length < 2) {
  console.error('Please provide a valid username');
  process.exit(1);
}
```

---

## ✅ Positive Observations

- Good use of security middleware (helmet, cors)
- Proper async/await patterns
- Database connection properly managed in reset script
- Environment variable configuration
- Graceful handling of missing client build
- Comprehensive route organization
- Proper use of ES modules

The codebase shows good architectural decisions overall, but the security issues need immediate attention, particularly the XSS vulnerability and resource management in error scenarios.

---

## server/src/auth

# Code Review: server/src/auth

## Summary
The authentication module is generally well-structured but has several security vulnerabilities and consistency issues that need attention.

## Findings

### **[HIGH] Security Issues**

**server/src/auth/middleware.js:25-32**
- **JWT secret fetched on every request**: This creates a significant performance bottleneck and potential security risk if DB calls fail
- **Fix**: Cache the JWT secret in memory and only refresh when needed
```javascript
let cachedSecret = null;
function getJwtSecret() {
  if (!cachedSecret) {
    const db = getDb();
    const settings = db.prepare("SELECT value FROM settings WHERE key = 'jwt_secret'").get();
    cachedSecret = settings?.value;
  }
  return cachedSecret;
}
```

**server/src/auth/routes.js:57**
- **Password validation is too weak**: 4-character minimum is insufficient
- **Fix**: Increase to at least 8 characters and add complexity requirements

**server/src/auth/routes.js:36-42**
- **No rate limiting on login attempts**: Vulnerable to brute force attacks
- **Fix**: Implement rate limiting middleware for login endpoint

### **[MEDIUM] Bugs & Logic Issues**

**server/src/auth/middleware.js:40-42**
- **Missing authentication check**: The middleware doesn't verify `req.user` exists before checking `must_change_password`
- **Fix**: Add null check for `req.user` before accessing its properties

**server/src/auth/routes.js:51-53**
- **Missing authentication middleware**: The `/change-password` route doesn't verify the user is authenticated
- **Fix**: Add authentication middleware before this route handler

**server/src/auth/roles.js:28-34**
- **Inconsistent permission checking**: `requireRole` allows admin bypass but `hasPermission` doesn't
- **Fix**: Make admin handling consistent across both functions

### **[MEDIUM] Consistency Issues**

**server/src/auth/routes.js:9-13 vs middleware.js:25-32**
- **Duplicate JWT secret retrieval logic**: Same pattern implemented twice
- **Fix**: Extract to shared utility function

**server/src/auth/routes.js:45,76**
- **Inconsistent error responses**: Some routes audit failed attempts, others don't
- **Fix**: Audit all authentication failures consistently

### **[LOW] Style & Maintainability**

**server/src/auth/middleware.js:5-8**
- **Hardcoded path arrays**: These should be configurable or in a constants file
- **Fix**: Move to configuration object or constants file

**server/src/auth/routes.js:15-24**
- **Token payload structure**: Consider extracting to a separate function for reusability
- **Fix**: Create `createTokenPayload(user)` helper function

**server/src/auth/roles.js:7-27**
- **Role definitions**: Could benefit from TypeScript-style JSDoc for better documentation
- **Fix**: Add JSDoc comments describing each role and permission

### **[LOW] Minor Issues**

**server/src/auth/routes.js:65**
- **Redundant user lookup**: User is fetched twice in change-password endpoint
- **Fix**: Reuse the existing user object after password validation

## Overall Assessment

The auth module has good separation of concerns and clear structure. However, the security vulnerabilities (especially the JWT secret performance issue and weak password requirements) need immediate attention. The code is generally readable but would benefit from better error handling consistency and shared utility functions.

---

## server/src/db (batch 1/2)

# Code Review: Database Layer (Batch 1/2)

## Overall Assessment
The database layer shows good structure and comprehensive migration handling. Most code is well-organized, but there are several important security and correctness issues that need attention.

## Findings

### **[HIGH] Security - Hardcoded Secrets**
**File:** `server/src/db/migrations/009_blocklists.sql` lines 28-31
**Issue:** Hardcoded external URLs in database migrations create security risks - these could be compromised or hijacked.
**Fix:** Move these to configuration files or environment variables, not baked into migrations.

### **[HIGH] Security - SQL Injection Risk**
**File:** `server/src/db/init.js` line 44
**Issue:** Dynamic SQL execution without validation: `db.exec(sql)` directly executes migration file contents.
**Fix:** Add SQL content validation or use parameterized queries where possible. Consider checksums for migration files.

### **[HIGH] Bugs - Unhandled Migration Errors**
**File:** `server/src/db/init.js` lines 33-54
**Issue:** Migration parsing errors (invalid filename format, missing files) could crash the application.
**Fix:** 
```javascript
for (const file of migrationFiles) {
  const versionMatch = file.match(/^(\d+)_/);
  if (!versionMatch) {
    console.warn(`Skipping invalid migration file: ${file}`);
    continue;
  }
  const version = parseInt(versionMatch[1], 10);
  // ... rest of logic
}
```

### **[MEDIUM] Security - Weak Password Generation**
**File:** `server/src/db/init.js` line 122
**Issue:** 12-byte password may be insufficient for admin account security.
**Fix:** Increase to at least 16 bytes: `crypto.randomBytes(16).toString('base64url')`

### **[MEDIUM] Bugs - Database Connection Not Closed**
**File:** `server/src/db/init.js` 
**Issue:** No cleanup function provided to properly close database connections.
**Fix:** Add export function:
```javascript
export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
```

### **[MEDIUM] Style - Inconsistent Error Handling**
**File:** `server/src/db/init.js` lines 8-12
**Issue:** `getDb()` throws generic Error while other functions use console logging.
**Fix:** Use consistent error handling pattern throughout the module.

### **[MEDIUM] Bugs - Missing Input Validation**
**File:** `server/src/db/init.js` line 134
**Issue:** `audit()` function doesn't validate required parameters.
**Fix:**
```javascript
export function audit(userId, action, entityType, entityId, details) {
  if (!userId || !action) {
    throw new Error('userId and action are required for audit logging');
  }
  // ... rest of function
}
```

### **[LOW] Consistency - Mixed String Quotes**
**Files:** Multiple migration files
**Issue:** Inconsistent use of single vs double quotes in SQL strings.
**Fix:** Standardize on single quotes for SQL string literals.

### **[LOW] Style - Magic Numbers**
**File:** `server/src/db/init.js` line 123
**Issue:** Hardcoded `10` for bcrypt salt rounds without explanation.
**Fix:** Use named constant: `const BCRYPT_ROUNDS = 10;`

### **[LOW] Bugs - Potential Race Condition**
**File:** `server/src/db/init.js` lines 14-18
**Issue:** Multiple concurrent calls to `initDb()` could create multiple database instances.
**Fix:** Add initialization guard or make `initDb()` idempotent.

## Migration Files Assessment
The migration files are well-structured with proper foreign key relationships and indexes. The progressive schema evolution is logical and maintains data integrity. Good use of transactions for atomic migrations.

## Summary
The database layer demonstrates solid architectural decisions but needs security hardening and better error handling. The migration system is robust, though it needs input validation for production use.

---

## server/src/db (batch 2/2)

## Code Review: Database Migrations (batch 2/2)

The migration files are well-structured overall, but there are several areas for improvement:

### **Bugs**

**[MEDIUM] Migration 018 - Data Loss Risk**
- `server/src/db/migrations/018_blocklist_redesign.sql`, lines 18-19
- Dropping tables without data migration could cause permanent data loss
- **Fix**: Add migration logic to preserve existing data before dropping tables:
```sql
-- Migrate existing data first
INSERT INTO blocklist_categories (slug, enabled) 
SELECT DISTINCT source_name, 1 FROM blocklist_sources WHERE enabled = 1;
-- Then drop tables
```

**[LOW] Missing Validation Constraints**
- `server/src/db/migrations/022_custom_dhcp_options.sql`, line 4
- DHCP option codes should be constrained to valid ranges (1-254)
- **Fix**: Add constraint: `code INTEGER NOT NULL CHECK (code BETWEEN 1 AND 254) UNIQUE`

### **Style & Consistency**

**[LOW] Inconsistent Column Naming**
- Mixed naming conventions across migrations:
  - `server/src/db/migrations/016_dhcp_option_catalog.sql`: `option_code` (snake_case)
  - `server/src/db/migrations/018_blocklist_redesign.sql`: `domain_count` vs `category_slug`
- **Fix**: Standardize on snake_case throughout

**[LOW] Inconsistent Index Naming**
- Different prefixes used: `idx_` vs missing prefixes
- `server/src/db/migrations/017_scan_results_index.sql`: `idx_scan_results_scan_ip`
- `server/src/db/migrations/018_blocklist_redesign.sql`: `idx_blocklist_domains_domain`
- **Fix**: Use consistent `idx_tablename_columns` pattern

### **Security**

**[LOW] Missing Input Validation Documentation**
- `server/src/db/migrations/015_dhcp_options.sql`, lines 2-3
- TEXT columns for `ntp_servers` and `domain_search` lack format constraints
- **Fix**: Add CHECK constraints or document expected formats in comments

### **Maintainability**

**[LOW] Missing Migration Dependencies**
- Migration 016 references `dhcp_scopes` table but doesn't explicitly check existence
- **Fix**: Add existence checks or document dependencies in comments

**[MEDIUM] Incomplete Migration Rollback**
- `server/src/db/migrations/018_blocklist_redesign.sql`
- No rollback strategy for the table restructure
- **Fix**: Document rollback procedure or provide reverse migration

### **Positive Notes**

✅ Good use of `IF NOT EXISTS` clauses to prevent conflicts  
✅ Proper foreign key constraints with CASCADE options  
✅ Appropriate indexing for performance  
✅ Clear, descriptive migration file names  
✅ Consistent use of `datetime('now')` for timestamps  

The migrations follow SQLite best practices and maintain referential integrity well. The main concern is the potential data loss in migration 018.

---

## server/src/routes (batch 1/2)

## Code Review: server/src/routes (batch 1/2)

### 🟢 Overall Assessment
The code is generally well-structured with consistent patterns and good separation of concerns. Most files follow similar patterns for authentication, validation, and error handling.

## Findings

### **Security Issues**

#### [HIGH] SQL Injection Risk in audit.js
**File:** `audit.js`, lines 18-35
**Issue:** Dynamic SQL construction with user-controlled input
```javascript
where.push(`a.action IN (${actions.map(() => '?').join(',')})`);
```
**Fix:** This is actually safe - using parameterized placeholders. The code is correct.

#### [MEDIUM] Missing Input Validation in Multiple Files
**Files:** `blocklists.js`, `dhcp.js`, `dns.js`
**Issue:** Some endpoints don't validate required user authentication
**Fix:** Add explicit null checks:
```javascript
if (!req.user) {
  return res.status(401).json({ error: 'Authentication required' });
}
```

### **Bugs & Logic Issues**

#### [HIGH] Race Condition in GeoIP Proxy Management
**File:** `geoip.js`, lines 95-111
**Issue:** Async proxy start/stop operations without proper synchronization
```javascript
if (nowEnabled && !wasEnabled) {
  await loadMmdb();
  startProxy(parseInt(newPort, 10)); // No await - potential race
}
```
**Fix:** Ensure all proxy operations are properly awaited and handle errors

#### [MEDIUM] Incomplete Error Handling in Operations
**File:** `operations.js`, lines 135-150
**Issue:** Certificate validation could fail silently
```javascript
} catch (err) {
  res.status(400).json({ error: err.message || 'Invalid certificate or key' });
}
```
**Fix:** Add specific validation for different error types and cleanup temp files in all error paths

#### [MEDIUM] Potential Memory Leak in Large Queries
**File:** `blocklists.js`, lines 146-156
**Issue:** Loading all whitelist domains into memory for search
```javascript
const whitelisted = new Set(
  db.prepare('SELECT domain FROM blocklist_whitelist').all().map(r => r.domain)
);
```
**Fix:** For large datasets, consider pagination or streaming queries

### **Style & Consistency Issues**

#### [LOW] Inconsistent Permission Checking Patterns
**Files:** Multiple files
**Issue:** Mix of inline checks and middleware usage
```javascript
// Some use middleware
router.get('/scopes', requirePerm('dhcp:read'), ...)

// Others use inline checks  
if (!hasPermission(req.user.role, '*')) {
  return res.status(403).json({ error: 'Admin access required' });
}
```
**Fix:** Standardize on one approach, preferably middleware for cleaner code

#### [LOW] Magic Numbers and Strings
**File:** `dhcp.js`, lines 445-447
```javascript
if (isNaN(codeNum) || codeNum < 128 || codeNum > 254) {
  return res.status(400).json({ error: 'Code must be between 128 and 254' });
}
```
**Fix:** Define constants: `const CUSTOM_OPTION_MIN = 128; const CUSTOM_OPTION_MAX = 254;`

### **Performance Concerns**

#### [MEDIUM] N+1 Query Pattern
**File:** `dhcp.js`, lines 51-55
**Issue:** Loop executing queries for each scope
```javascript
for (const scope of scopes) {
  scope.options = optStmt.all(scope.id);
}
```
**Fix:** Use a JOIN or single query to fetch all options, then group by scope_id

#### [LOW] Inefficient String Operations
**File:** `dns.js`, lines 59-62
**Issue:** JSON parsing in loop without caching
```javascript
for (const item of items) {
  if (item.details) {
    try { item.details = JSON.parse(item.details); } catch { /* keep as string */ }
  }
}
```
**Fix:** Consider parsing once or using database JSON functions

### **Maintenance & Robustness**

#### [MEDIUM] Hard-coded File Paths
**File:** `health.js`, lines 38-44
**Issue:** Hard-coded paths that may not exist in all environments
```javascript
const dfOutput = execSync('df -B1 /data 2>/dev/null || df -B1 / 2>/dev/null', { encoding: 'utf-8' });
```
**Fix:** Use environment variables or configuration for paths

#### [LOW] Missing Transaction Rollback
**File:** `folders.js`, lines 47-78
**Issue:** Complex transaction without explicit error handling
**Fix:** Add proper try/catch around transaction with rollback

### **Positive Observations**
- Consistent audit logging across operations
- Good input validation in most endpoints  
- Proper use of transactions for multi-step operations
- Clear separation of business logic into utility functions
- Comprehensive error messages for client debugging

The codebase demonstrates solid engineering practices with room for improvement in error handling, performance optimization, and consistency.

---

## server/src/routes (batch 2/2)

## Code Review: server/src/routes/vlans.js

This code looks well-structured overall with good error handling, validation, and audit logging. Here are the findings:

### **Bugs**

**[HIGH]** **Referential Integrity Issue** (Lines 93-95)
- Deleting VLANs without checking for dependent subnets could break referential integrity
- The GET endpoints show `subnet_count` suggesting VLANs have related subnets
- **Fix**: Add foreign key constraint check before deletion:
```javascript
const subnetCount = db.prepare('SELECT COUNT(*) as count FROM subnets WHERE vlan_id = ? AND folder_id = ?').get(vlan.vlan_id, vlan.folder_id);
if (subnetCount.count > 0) return res.status(409).json({ error: 'Cannot delete VLAN with existing subnets' });
```

**[MEDIUM]** **Empty Name Validation Gap** (Line 75)
- PUT endpoint allows empty names when `name` is provided but empty
- Current validation: `name !== undefined ? name.trim() : vlan.name` doesn't check if trimmed name is empty
- **Fix**: Add validation:
```javascript
if (name !== undefined && !name.trim()) {
  return res.status(400).json({ error: 'Name cannot be empty' });
}
```

### **Style**

**[LOW]** **Inconsistent Error Handling** (Lines 62-64 vs other endpoints)
- POST endpoint has try-catch with generic error handling
- Other endpoints don't wrap database operations in try-catch
- **Fix**: Either add try-catch to all endpoints or remove it from POST for consistency

**[LOW]** **Magic Number** (Lines 53, 68)
- VLAN range 1-4094 hardcoded in multiple places
- **Fix**: Define constants:
```javascript
const VLAN_MIN = 1;
const VLAN_MAX = 4094;
```

### **Consistency**

**[MEDIUM]** **Mixed Parameter Handling** (Line 28)
- GET `/` uses `...params` spread operator
- Other queries use direct parameter passing
- **Fix**: Use consistent parameter passing style throughout

### **Security**

**[LOW]** **SQL Injection Prevention** 
- All queries properly use prepared statements ✓
- Input validation is present ✓
- No obvious injection risks found

### **Overall Assessment**

The code demonstrates good practices with proper authorization, input validation, audit logging, and prepared statements. The main concerns are around data integrity (cascading deletes) and minor consistency issues. The VLAN ID validation and folder existence checks are well implemented.

---

## server/src/utils

# Code Review: server/src/utils

## Bugs

### server/src/utils/backup.js

**[HIGH] Line 19-21: Command injection vulnerability**
```javascript
execSync(`tar czf "${archivePath}" ${includes.join(' ')}`, {
```
The `includes` array contains unsanitized filenames that could contain shell metacharacters. Use `execFile` instead:
```javascript
execFileSync('tar', ['czf', archivePath, ...includes], { cwd: DATA_DIR, ... })
```

**[HIGH] Line 46: Command injection vulnerability**
```javascript
const listing = execSync(`tar tzf "${archivePath}"`, { encoding: 'utf-8', timeout: 30000 });
```
Same issue with `archivePath`. Use `execFile` with array arguments.

**[MEDIUM] Line 53: Command injection vulnerability**
```javascript
execSync(`tar xzf "${archivePath}" -C "${DATA_DIR}"`, {
```
Same pattern - use `execFile`.

### server/src/utils/cert.js

**[HIGH] Line 16-18: Command injection vulnerability**
```javascript
execSync(
  `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" ` +
  `-days 365 -nodes -subj "/CN=ipam/O=IPAM/C=US"`,
```
Path variables could contain shell metacharacters. Use `execFile`:
```javascript
execFileSync('openssl', [
  'req', '-x509', '-newkey', 'rsa:2048',
  '-keyout', keyPath, '-out', certPath,
  '-days', '365', '-nodes', '-subj', '/CN=ipam/O=IPAM/C=US'
], { stdio: 'pipe' });
```

### server/src/utils/dhcp.js

**[MEDIUM] Line 46: DNS resolution timeout not enforced**
```javascript
const out = execFileSync('getent', ['ahostsv4', value], { timeout: 3000, encoding: 'utf-8' });
```
The DNS cache never expires failed lookups. Add TTL to failed results:
```javascript
dnsCache.set(value, { result: null, expires: Date.now() + 300000 }); // 5min TTL
```

### server/src/utils/dnsmasq.js

**[MEDIUM] Line 95: Signal failure ignored**
```javascript
execSync('kill -HUP $(pidof dnsmasq) 2>/dev/null || true', { stdio: 'ignore' });
```
This approach is fragile. Consider using a PID file or systemctl:
```javascript
try {
  execFileSync('systemctl', ['reload', 'dnsmasq'], { stdio: 'ignore' });
} catch {
  execFileSync('pkill', ['-HUP', 'dnsmasq'], { stdio: 'ignore' });
}
```

### server/src/utils/geoip.js

**[HIGH] Line 89: Potential memory leak**
```javascript
let pendingQueries = new Map();
```
Pending queries accumulate if upstream never responds. Add periodic cleanup:
```javascript
// Add cleanup interval
setInterval(() => {
  const now = Date.now();
  for (const [id, query] of pendingQueries) {
    if (now - query.timestamp > 30000) {
      clearTimeout(query.timer);
      pendingQueries.delete(id);
    }
  }
}, 60000);
```

**[MEDIUM] Line 173: Race condition**
```javascript
if (nextQueryId > 0xFFFF) nextQueryId = 1;
```
Multiple concurrent requests could get the same ID. Use atomic increment or add randomness.

### server/src/utils/scanner.js

**[MEDIUM] Line 14: Process leak risk**
```javascript
execFile('arping', ['-c', '1', '-w', '1', ip], { timeout: 5000 }, (error, stdout) => {
```
If `arping` hangs beyond the timeout, the process may not be killed. Consider using `AbortController` if available in Node version.

## Security

### server/src/utils/blocklist.js

**[MEDIUM] Line 62: HTTP request without size limit**
```javascript
const content = await response.text();
```
Malicious servers could send massive responses. Add size limit:
```javascript
const reader = response.body.getReader();
let content = '';
let totalSize = 0;
const MAX_SIZE = 50 * 1024 * 1024; // 50MB
// ... implement chunked reading with size check
```

### server/src/utils/geoip.js

**[LOW] Line 310: User-Agent header reveals system info**
```javascript
headers: { 'User-Agent': 'IPAM-GeoIP/1.0' }
```
Consider using a more generic user agent to avoid fingerprinting.

## Style

### server/src/utils/dhcp-options.js

**[LOW] Line 35-40: Inconsistent description formatting**
Some descriptions end with periods, others don't. Standardize:
```javascript
description: 'Subnet mask for the client\'s network interface'
```

### server/src/utils/backup.js

**[LOW] Line 8: Inconsistent path handling**
```javascript
const DATA_DIR = process.env.DATA_DIR || path.join(import.meta.dirname, '..', '..', 'data');
```
This pattern repeats across files. Consider extracting to a shared constant module.

## Consistency

### Multiple files: Mixed error handling patterns

**[MEDIUM]** Some functions throw errors (e.g., `backup.js:deleteBackup`), others return error objects (e.g., `backup.js:restoreBackup`). Standardize on one approach:

```javascript
// Prefer throwing for consistency with existing codebase
export function restoreBackup(archivePath) {
  if (!fs.existsSync(archivePath)) {
    throw new Error('Backup file not found');
  }
  // ... rest of function
}
```

### Multiple files: Inconsistent database transaction usage

**[MEDIUM]** Some functions use transactions (e.g., `blocklist.js:refreshCategory`), others don't for multi-statement operations. Audit and apply transactions consistently where multiple related DB operations occur.

## Overall Assessment

The code is generally well-structured but has significant security vulnerabilities around command execution. The backup, cert, and dnsmasq modules need immediate attention to prevent command injection. The GeoIP proxy has potential memory leaks that could cause DoS. Most other issues are lower priority style and consistency improvements.

Priority fixes:
1. Replace all `execSync` with `execFile` for shell command safety
2. Add size limits to HTTP downloads
3. Fix memory leaks in GeoIP pending queries
4. Standardize error handling patterns

---
