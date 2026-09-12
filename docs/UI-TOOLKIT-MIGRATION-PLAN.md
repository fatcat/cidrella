# UI Toolkit Migration Plan

Date: 2026-09-12
Status: decided
Target: not 0.5.0, see Phase 1b
Selection: **OpenVue 1.0.0** as the near-term swap (about one day, bounded
downside). **Element Plus 2.14.5** documented as the long-term move, to be
bundled with the 0.5.0 redesign. Grid: **gridstack 13.3.0**, settled, chosen
independently and adoptable now.
Prerequisite: **Prettier adopted and swept** as its own commit, Phase 0a. That
reverses a standing repo rule and is what makes the token rename in Phase 0b
affordable.

## Why This Matters

PrimeTek moved PrimeVue 5 and later to a dual-license model. Builds from v5 up
carry an offline license-key check and paint a red "Invalid PrimeUI License"
watermark without a registered key. A free community license exists and CIDRella
would qualify, but that route was rejected: a shipped appliance should not carry
a licensing dependency.

Staying on 4.5.5 carries zero license risk permanently. MIT grants are
irrevocable and 4.5.5 predates the key-check code entirely, so it can never show
the watermark. The problem is support, not licensing: `primefaces/primevue` was
archived read-only on 2026-06-28. There is no LTS branch and no backports. The
code we ship is frozen and will not receive security patches.

That is tolerable for now (self-hosted, small scale, UI behind the app's own
auth) and it is not an emergency. It is also not a permanent position.

A second, independent pressure arrived with 0.5.0: a draggable, resizable widget
dashboard is on the roadmap. PrimeVue 4.5.5 has no grid or dashboard component
and no drag-and-drop directive at all. That gap has to be filled from outside
the toolkit regardless of which toolkit we land on.

## Current State

Measured 2026-09-12 against the working tree. These numbers drive the cost
estimates below, so re-measure before acting on a stale copy of this document.

### Components

- PrimeVue 4.5.5, `@primeuix/themes` 2.0.3, `primeicons` 7.
- `primeicons` is a separate MIT package, unaffected by the license change. It
  stays regardless of the outcome.
- 32 files in `client/src/ui/`: 29 component re-exports, the `useToast`
  composable, plus `plugin.js` and `theme.js`. 34 distinct `primevue/*`
  subpaths.
- Every one is wrapped one-per-file in `client/src/ui/` as a plain re-export:

  ```js
  // Button: re-export of the vendor component.
  export { default } from 'primevue/button';
  ```

- **Zero files outside `client/src/ui/` import `primevue` or `@primeuix`.** The
  wrapper discipline documented in `client/src/ui/README.md` is fully enforced.
- **712 component tag sites across the `.vue` files**, plus 20 `v-tooltip`
  directive usages in 9 files. Heaviest: Button 237, Column 109, InputText 104,
  Dialog 53, Select 33, InputNumber 26, DataTable 24.

The shim was built in anticipation of exactly this migration, and it works, but
be precise about what it buys. **It caps the import churn, not the API churn.**

- For a **same-API fork**, the import churn is the whole job. Prop names are
  identical, the 712 tag sites are untouched, and the swap really is ~32 files
  in one directory. The July spike demonstrated this end to end.
- For a **clean break**, every one of those 712 tag sites is also a prop
  remapping, because the vocabularies differ (`value` / `optionLabel` /
  `stripedRows` against `items` / `item-title` / `striped`). Any estimate that
  says "one directory" for a clean break is wrong, and an earlier draft of this
  document said exactly that.

The mitigation is to turn the 29 one-line re-exports into adapter SFCs that
translate props, which caps most of it. `DataTable` is the exception and the
real work: PrimeVue expresses columns as `<Column>` children, most alternatives
take a `headers` array, and that is 24 tables and 109 columns to restructure.
Treat that adapter as the load-bearing risk of any clean break, not a formality.

### Dead weight to drop first

`useConfirm` and `confirm.require` have **zero call sites** in `client/src`. The
`ConfirmationService` plugin is registered in `main.js` and never used. Removing
it is free and takes one subpath off every estimate below.

### CSS

This is the larger surface and the one without a shim yet.

- 828 `var(--p-*)` reads across 56 files.
- Those resolve to only **50 unique token names**.
- 24 `:deep(.p-*)` class selectors.

The 50 tokens split into two layers with very different migration properties:

| Layer | Distinct | Refs | Notes |
|---|---|---|---|
| Semantic | 30 | 673 | `surface-*`, `text-*`, `primary-*`, `content-*`, `highlight-*`, `form-field-*`. Must track the active theme at runtime. |
| Raw palette | 20 | 155 | `--p-red-500`, `--p-green-400` and similar. Fixed points on a color scale. Static hex, satisfiable by hand, independent of any toolkit. |

The distribution is top-heavy. Six tokens carry 69% of all reads:

```
172  --p-text-muted-color
127  --p-surface-border
 85  --p-primary-color
 80  --p-text-color
 73  --p-surface-card
 53  --p-surface-ground
```

`client/src/App.vue` already redefines four of these in its own `:root`, because
the app wanted its own elevation hierarchy rather than PrimeVue's:

```css
--p-surface-ground: var(--p-surface-100);
--p-surface-card: var(--p-surface-0);
--p-surface-content: var(--p-surface-0);
--p-surface-border: var(--p-surface-200);
```

Those four alone account for 253 of the 828 reads. A token shim is therefore an
extension of established practice here, not a new mechanism.

### Theming

- 13 themes: 6 light, 6 dark, plus Nord dark.
- Each is a custom 11-shade primary plus 12-shade surface palette.
- Applied at runtime through `updatePreset` and `updateSurfacePalette` from
  `@primeuix/themes`.
- Files: `client/src/main.js` and `client/src/ui/theme.js`.

**Runtime palette swapping is a hard requirement.** A toolkit that only themes
at build time kills this feature.

### Not a factor

- Charts. The app uses `chart.js` and `vue-chartjs` directly, never the
  toolkit's chart component.
- Icons. `primeicons` is separate and MIT.

## Proposed Target

Two shim layers, so the toolkit is swappable rather than load-bearing:

1. **Component shim.** Already exists: `client/src/ui/`. No change to the
   pattern, only to what the 29 wrappers re-export.
2. **CSS token shim.** To be added. One file owning all 50 tokens, so no
   component stylesheet ever reads a vendor token directly.

After both are in place, a **same-API** replacement touches `client/src/ui/`,
the token shim, and the two theme files. Nothing else.

A **clean-break** replacement additionally needs the 29 wrappers promoted from
re-exports to prop-translating adapter SFCs, and `DataTable` restructured. The
712 tag sites stay untouched only to the extent those adapters succeed. Budget
for that separately and do not let the tidiness of the shim disguise it.

### The central design decision: token naming (DECIDED 2026-09-12)

**Decision: rename onto the existing `--cid-*` namespace.** This was previously
written up as Option A (keep `--p-*`, define them ourselves) versus Option B
(rename). Option A was recommended. Three findings reversed it, and the first
one is disqualifying rather than merely persuasive.

**Option A collides with the vendor and cannot work here.** It called for
redefining all 52 tokens ourselves, including the 32 raw palette tokens the kit
owns. But `--p-*` is exactly what OpenVue emits natively, and what
`updatePreset` / `updateSurfacePalette` rewrite at runtime on every theme
change. Redefining those in a static `:root` block puts our shim in a cascade
fight with the live theme system. The codebase already knows this: `App.vue`
shims precisely 4 tokens and its comment states the rule explicitly, that
PrimeVue "does NOT define" them, so the existing pattern is to define only
tokens the vendor leaves absent. Option A inverts that pattern.

**The namespace already exists, so this is not a new invention.** `App.vue`
defines about 30 `--cid-*` tokens already (entity colors, status, charts,
gauges). Phase 0b finishes a namespace that is half built rather than starting
one. That also kills the "vendor prefix outliving the vendor" awkwardness
without inventing a third naming scheme.

**The blame objection is gone.** Option A's case rested on this repo having no
Prettier "precisely because a mass reformat would destroy blame." Prettier is
now adopted (Phase 0a), and the mechanism that made that acceptable,
`.git-blame-ignore-revs`, applies identically to a mechanical token rename. The
argument that chose A no longer exists.

Cost of the rename, measured: **755 lines across 58 files**, one mechanical
single-token substitution each. It lands as its own commit and goes into
`.git-blame-ignore-revs` alongside the formatting sweep.

## Migration Steps

### Phase 0a: formatting baseline, Prettier (VALIDATED, awaiting commit)

Reverses the repo's standing no-Prettier rule. Rationale, in order of weight:

1. **Adoption is all-or-nothing, not gradual.** The global format-on-edit hook
   activates the moment a Prettier config exists. A partly swept tree would
   then drip formatting noise into every unrelated commit indefinitely. So the
   real choice is one sweep or no config, and a half-migrated CSS layer is the
   worst of the three.
2. **It makes Phase 0b reviewable.** Much of the CSS in the preview views is
   crammed multiple-rules-per-line, up to 3280 characters on one line. The
   token rename touches 755 of those lines. Expanded first, that diff is
   readable. Unexpanded, it is a wall of 1800-character line rewrites.
3. **The original objection is handled.** The rule existed to protect
   `git blame`. `.git-blame-ignore-revs` solves that natively and GitHub honors
   it with no local config.

Settings were measured off the existing code, not taken as defaults: single
quotes (708 to zero in the tree), `printWidth: 100` (p95 of real line length
was 94, so 80 would have reflowed 5514 lines instead of 2196), Vue `<script>`
left flush with the tag, arrow parens always (150 to 61). Scope is code only,
`.js` `.vue` `.css`. Markdown, JSON, YAML and HTML are ignored so hand-formatted
prose and machine-parsed files keep their shape.

Validated on a throwaway copy of the tree, not in place:

- **352 files** reformat: 287 `.js`, 64 `.vue`, 1 `.css`.
- Diff scale: 362 files changed, +33304 / -12580. The net growth is crammed CSS
  expanding.
- Server suite **1090 passing, unchanged**. Client **245 passing** after one fix.
- `eslint .` exits 0. Client build succeeds.
- Prettier itself: 3.9.6, pinned exact, MIT, **zero dependencies**, one lockfile
  entry. The `brace-expansion` advisory npm reports was already in the committed
  lockfile via `eslint -> minimatch`, so it is pre-existing and unrelated.

One test broke and it is worth recording why. `SubnetDetailGridInteractions`
asserts on `.vue` source as *text*, and Prettier split a single-line ternary
across three lines, so a literal `toContain` substring stopped existing. Fixed
by making that one assertion whitespace tolerant, which also matches the
pre-sweep form. Mutation tested: renaming the flag, changing the label text and
dropping the ternary are all still caught.

**Sequencing constraint.** The sweep must land on a clean tree. If it is mixed
with feature work, that commit cannot honestly go into
`.git-blame-ignore-revs`, because blame would then permanently skip real
authorship. Commit pending work first, sweep second, then append the sweep's
SHA to the ignore file in a third small commit (a commit cannot contain its own
hash).

### Phase 0b: CSS token shim (DONE 2026-09-12)

Does not depend on which kit we choose, and earns its keep even if the toolkit
never changes, because it converts scattered vendor references into one
reviewable file. Measured surface: **52 unique tokens, 755 lines, 58 files**,
split **32 raw palette / 20 semantic**.

1. Extend the existing `--cid-*` block in `App.vue`, or lift it to
   `client/src/ui/tokens.css` beside the component shim, so there is one owner.
2. Define the 32 raw palette tokens as `--cid-*` pointing at the kit's ramp
   (`--cid-surface-200: var(--p-surface-200)`). One indirection, so a kit swap
   edits this file only. Do **not** redefine `--p-*` itself, see the token
   naming decision.
3. Map the 20 semantic tokens the same way, preserving current values so there
   is no visual delta.
4. Rewrite the 755 call sites to read `--cid-*`. Mechanical, one commit, goes
   into `.git-blame-ignore-revs`.
5. Update the 3 test references to `--p-*`. Two are fixture literals in
   `gridClassification.test.js`, one of which (`--p-dhcp-pool`) is dead and
   should be deleted rather than renamed. The third is a `not.toContain` source
   assertion in `SubnetDetailGridInteractions.test.js`.
6. Verify: build, full client suite, and a Playwright pass across all 13 themes
   confirming no visual change.

**Done.** `client/src/ui/tokens.css` holds 44 aliases, `App.vue` keeps the 4
semantic surface tokens it invented (now `--cid-*`, built on the aliases), and
2 names were dropped as dead. Exit criterion verified mechanically: zero
`var(--p-` reads and zero `--p-*:` declarations outside the shim, 44 reads
inside it.

Landed as 5 commits, `b2fc290` through `9d1e8d8`, with the 819-line
substitution isolated in `5244c85` so it could go into
`.git-blame-ignore-revs` honestly. That commit was proved mechanical rather
than asserted: mapping `--cid-*` back and stripping whitespace reproduces its
parent byte for byte across all 57 files.

Equivalence was verified in a browser, not reasoned about. 50 tokens times 6
themes is 300 comparisons: 264 resolve identically to the `--p-*` they
replaced, 24 are the App.vue-owned four where `--p-*` is now correctly
undefined and `--cid-*` carries a value matching the pre-rename capture with
zero drift, and 12 are the two dead names, empty before and after. A light and
a dark theme were also checked visually.

Note for the record: the theme count in this document was wrong. `dev/0.5.0`
ships **6** themes, not 13. The 13 predate the 0.5.0 cleanup.

**Two dead tokens surfaced, one of them a real defect.**
`--p-surface-hover` was never defined by the library and computes to empty in
every theme, and 4 call sites read it bare with no fallback, so those hover
backgrounds have never painted. `--p-surface-content-muted` is the same shape
but harmless, since both its call sites supply a fallback. Neither was fixed
in Phase 0b, because the rename commit is blame-ignored and had to stay
mechanical. Logged in `BACKLOG.md` under Open defects.

**What this phase does not cover.** 46 deep `.p-*` class selectors reach into
vendor internals, and tokens cannot abstract those. They survive OpenVue
unchanged because the class prefix is identical, and they are real work on any
later move to Element Plus. See Phase 4.

### Phase 1: select the toolkit (DECIDED 2026-09-12)

**OpenVue 1.0.0** (`openvi-foundation/openvue`, npm `openvue`), a PrimeVue 4
continuation fork. Element Plus becomes the documented long-term move, see
below. BumbleVue rejected.

The decision rests on cost and reversibility, **not** on project health. Be
clear about that, because on health it loses: Element Plus has 128 commit
authors, 499k weekly downloads and npm provenance, against OpenVue's 7 authors,
~2k weekly downloads and none.

#### Why OpenVue anyway

1. **Cost asymmetry of roughly 10x.** OpenVue is about one day. It preserves the
   PrimeVue API exactly, keeps the `--p-*` variables and the `p-*` classes, and
   ships a published codemod. Element Plus is 1.5 to 2 weeks plus visual QA over
   71 views, for zero user-visible benefit.
2. **The downside is bounded, and this is what actually decides it.** Because
   OpenVue preserves the API, `client/src/ui/` stays as it is. If OpenVue dies in
   six months we are exactly where we are today: pinned to a frozen MIT fork,
   with Element Plus still available at the same 1.5 to 2 week cost. Adopting
   OpenVue forecloses nothing. **The cost of being wrong is one day.**
3. The supply-chain audit is clean, and the code additions are attributable to
   named contributors with public review trails rather than anonymous deltas.
4. It is already shipping fixes this codebase wants: datatable column-width
   persistence on column toggle (PR #627, and CIDRella has 24 tables) and row
   groups with virtual scrolling (PR #621, which `DHCP.vue` uses via
   `rowGroupMode="subheader"`).

#### Verified technical fit

- All **34 subpaths** CIDRella imports exist. Zero missing.
- **CSS variable prefix is still `p`** and **CSS classes are still `p-*`**, both
  verified in the shipped `@openuxkit/styled` and style modules. So all 828
  `var(--p-*)` reads **and** all 24 `:deep(.p-*)` selectors survive untouched.
- Theming ports directly. See the API mapping under Phase 3.
- No `preinstall`/`install`/`postinstall` in any of the 7 packages, so all pass
  `scripts/check-install-scripts.js`.
- `@openvue/migrate` 1.0.0 is a published codemod: MIT, **zero dependencies**,
  no install scripts, renames deps, rewrites imports, and previews with `--dry`.
- Keep `primeicons` 7.0.0. It is a separate MIT package unaffected by the
  relicense. Their `openicons` continuation is not needed.

#### Supply-chain audit: clean

Same method as the July BumbleVue audit. All 7 tarballs pulled with curl direct
from the registry (no `npm install`, so nothing could execute), every file
canonicalized through the openvue/primevue rename, then md5-compared against
genuine `primevue@4.5.5`, `@primevue/core`, `@primevue/icons`,
`@primeuix/themes`, `@primeuix/styled` and `@primeuix/utils`.

- File counts align: openvue 1387 against primevue 1381. A fork that added
  meaningfully would show here.
- `@openvue/icons`: **50 of 50 byte-identical.** `@openvue/core`: 14 of 15, the
  one diff being two added i18n strings. `@openuxkit/themes`: 353 of 363.
- `@openuxkit/styled`, the theme engine and most security-sensitive file: 1341
  token changes, essentially all single-letter minifier renames. No logic added.
- Of 48 differing `.mjs` in the main package, **41 share one pattern**: upstream
  emits `key: 0` in a props object where OpenVue's build passes it positionally.
  That is `@vue/compiler-sfc` output drift, not hand-written code.
- **Danger-pattern scan over 811 files**: zero hits for `fetch(`, `WebSocket`,
  `sendBeacon`, `new Function`, `eval(`, `child_process`, `process.env`,
  `os.homedir`, `.npmrc`, `.ssh`, `document.cookie`, `atob`/`btoa`,
  `insertAdjacentHTML` and the rest. The four categories that did hit
  (`XMLHttpRequest`, web storage, `import()`, `innerHTML`) resolve to the
  **identical file set as genuine upstream**.
- Exactly 5 http URLs in the tree, the same five the July BumbleVue audit found
  in its fork, so both inherit them and neither added any. Zero raw IPs, zero
  long base64 blobs.
- No PrimeVue 5 license machinery: no "Invalid PrimeUI", no licenseKey, no
  Ed25519, no `attachShadow`, no telemetry.

**Cross-validation, the strongest single result:** the genuine feature work the
byte-diff found maps one-to-one onto merged external PRs (#26 password a11y,
#621 row groups, #627 column widths). The additions are attributable, not
anonymous deltas taken on trust.

Stated caveat: `primevue@4.5.5` published 2026-04-08, the fork took master on
2026-07-14, upstream archived 2026-06-28. So up to ~3 months of unreleased
upstream master drift sits inside the "fork changes" bucket and authorship of
some substantial diffs cannot be cleanly attributed. Everything observed is
benign either way.

#### Governance: candid, but not an institution

Do not be misled by the name, and note they are not trying to mislead.

- Org created 2026-07-14, the same day as the fork. `is_verified: false`. Zero
  public members. No `GOVERNANCE.md` or `FUNDING.yml` in the repo (there is a
  governance page on the website).
- Their own FAQ, verbatim: "There is no company behind it and no funding."
  Governance page: "We are actively building out the maintainer team", and on
  continuity, "If the current maintainers step away, anyone can fork the work
  under MIT." Honest, and not a continuity plan.
- The individuals are not established: njevric has 2 public repos and 14
  followers, dekitriv 1 repo and 5 followers. **On individual track record
  BumbleVue's sole maintainer is the stronger party** (152 repos, 121
  followers). Both facts are real and neither is decisive.
- **The decisive difference from BumbleVue: external PRs actually get merged.**
  46 merged PRs, of which 4 are from 4 distinct outside contributors spread
  across July, August and September. BumbleVue: 16 merged, 100% its own
  maintainer, zero external ever.
- **Publishing is one credential, not two.** All 7 packages list both
  maintainers, but `_npmUser` on every latest version is njevric. dekitriv has
  never published. Two names on the ACL does not reduce the single-account
  attack surface.
- One testable claim, "no direct pushes to main", checked out: loose-looking
  chore commits on master resolve to PRs. Branch protection itself is not
  determinable without admin rights, so its 404 says nothing either way.

#### Adoption, measured weekly

```
                    OpenVue   BumbleVue
  2026-08-15..21      2,686       153
  2026-08-22..28      1,804        44
  2026-08-29..09-04   1,041        11
  2026-09-05..11      2,065        11
```

OpenVue holds a flat 1,000 to 2,700 band. **BumbleVue is collapsing.** Scale
check for honesty: `primevue` itself is 574,961 per week, so OpenVue is 0.36% of
it. Real traffic, tiny project.

#### Element Plus 2.14.5: the documented long-term move

Not rejected, deferred. Promote it to the active plan as soon as the 0.5.0
redesign touches these views anyway, since the remaining redesign items are the
unified status system, empty states and tab-nesting flattening, and `el-empty`
covers the empty-states item directly. Marginal cost at that point is far below
1.5 to 2 weeks.

Its merits, unchanged: MIT, 2 npm maintainers, 128 commit authors over 12
months, 499k weekly downloads, npm provenance present. It keeps the
column-children model (`<el-table-column>` maps onto `<Column>`, where Vuetify's
`headers` array would restructure 24 tables and 109 column tags), covers all 29
components 1:1 or near including `el-transfer` for the one PickList, and themes
at runtime through 569 CSS custom properties with no API needed. One loss: no
tooltip directive, so 20 `v-tooltip` sites become markup.

Runner-up if Element Plus is ever ruled out: **Vuetify 4.2.1**. Rejected:
**Quasar** (runtime theming limited to 7 brand colors), and Reka UI, shadcn-vue
and Nuxt UI on component coverage.

#### BumbleVue: rejected

It shipped stable 1.0.0 on 2026-08-21 and still works technically (re-verified:
all 34 subpaths present, theming exports intact, prefix still `p`, no install
scripts). Every non-technical gate failed: 11 downloads per week and falling,
49 commits 100% by one person, zero external PR ever merged, silent since
2026-08-23, no provenance, and a "stable" 1.0.0 depending on three subpackages
at `rc.1`. Version 1.0 was a version number, not a maturity event.

#### Conditions to reverse

- Abandon OpenVue if njevric stops and nobody else gains merge rights, or if
  weekly downloads fall back under ~500, or if any version bump fails the
  fork-diff audit.
- Promote Element Plus when the 0.5.0 redesign reaches these views.
- BumbleVue stays rejected.

### Phase 1b: timing (deliberate)

Do not rush this into 0.5.0. `gh api /advisories?ecosystem=npm&affects=primevue`
returns **zero advisories across PrimeVue's entire life**, so the "frozen 4.5.5
is a security liability" argument is not supported by evidence today. For
contrast, Vuetify has 3 historical advisories and Element Plus 2, all patched.
4.5.5 is a safe holding position. Schedule the swap on its own, the way the
Vite 8 plan was kept off the release path.

### Phase 2: swap the component shim

0. Delete the unused `ConfirmationService` registration and `useConfirm`
   wrapper first. Zero call sites, so this is free.
1. Same-API fork: rewrite the 29 wrappers in `client/src/ui/` to re-export the
   new kit. Mechanical find-and-replace, the 712 tag sites are untouched.
2. Clean break: promote each wrapper to an adapter SFC that translates props,
   so the 712 call sites keep the PrimeVue vocabulary they already use.
   Sequence by weight, since 7 components carry 82% of the sites: Button 237,
   Column 109, InputText 104, Dialog 53, Select 33, InputNumber 26,
   DataTable 24.
3. `DataTable` last and on its own. `<Column>` children against a `headers`
   array is a structural difference an adapter cannot fully hide, across 24
   tables and 109 columns. If this one cannot be made to work cleanly, that is
   a reason to reconsider the kit, not to push through.
4. Port the 20 `v-tooltip` directive usages. Directives rarely port as-is.
5. Verify per component against the existing client test suite.

### Phase 3: port the theme system

1. Repoint the 30 semantic tokens in the shim at the new kit's theming output.
2. Port `updatePreset` and `updateSurfacePalette` in `client/src/ui/theme.js`
   and `client/src/main.js` to the new kit's runtime theming API.
3. Verify all 13 themes produce distinct, correct light and dark palettes. The
   prior BumbleVue spike exercised 6 themes through the real Pinia store and
   checked the resulting custom property values, so reuse that method.

#### API mapping for OpenVue

`@openvue/themes/index.mjs` is a one-line facade:

```js
export * from '@openuxkit/styled';
```

That mirrors how `@primeuix/themes` re-exports `@primeuix/styled`, so
`updatePreset` and `updateSurfacePalette` port across directly and
`client/src/ui/theme.js` stays a two-line re-export. `updatePrimaryPalette`
comes along as something the app does not currently use but could (see below).
Note the preset subpath pattern differs: `exports` declares `./aura/*` rather
than a bare `./aura`, so the `@primeuix/themes/aura` import needs its specifier
checked rather than assumed.

#### Borrowed idea: derive a third scheme instead of authoring one

Independent of the toolkit decision, because this is a comment on our own theme
store rather than on any kit.

`openvi-foundation/deni` (their OpenVue dashboard template,
`src/composables/useTheme.ts`) offers a third colour scheme, "Dim", a softer
dark. It is not a hand-authored palette. It is the existing dark ramp shifted
one step lighter:

```js
const DIM_SHIFT = 1;
// each step points at the previous step of the same ramp
map[step] = `{${color}.${STEPS[Math.max(0, index - shift)]}}`;
// ...
updateSurfacePalette({ light: paletteRef(light), dark: paletteRef(dark, DIM_SHIFT) });
```

CIDRella has 6 dark themes. A dim variant of each would be close to free by the
same trick, and it is a real accessibility and comfort win for an appliance UI
people leave open on a wall display. Worth doing whether or not the toolkit
changes.

Two related techniques from the same file are worth copying:

- **Presets loaded by dynamic `import()`**, so only the chosen one enters the
  bundle rather than all four.
- **Scheme applied as root classes before mount** (`app-dark`, `app-dim`), which
  is what avoids a flash of the wrong scheme on load.

What does **not** transfer: deni composes a theme from four orthogonal axes
(preset, scheme, primary hue, surface tint) built out of the preset's own named
ramps. That cannot express CIDRella's 13 curated palettes, which are hand-tuned
identities (Nord, Catppuccin, Gruvbox, Rosé Pine, Starry Night) rather than hue
picks. Keep the curated list. If more flexibility is ever wanted, the cheap
addition is a primary-hue override layered on top of the chosen theme using
`updatePrimaryPalette`, not a switch to the compositional model.

### Phase 4: `:deep()` selector cleanup

24 selectors reaching into vendor internals. If the new kit emits different
class names, each needs rewriting. Small, but it is the one piece that cannot be
shimmed, since it reaches past the shim by design.

Worth considering whether some of these should become proper component props or
passthrough options instead of restored as selectors.

### Phase 5: dashboard grid (separate workstream, adoptable now)

**gridstack 13.3.0.** MIT, **zero runtime dependencies**, 419k weekly
downloads, 3 npm maintainers, 11 distinct commit authors over 12 months, and it
ships **first-party Vue 3 components** (`GridStackComponent`, `GridStackItem`,
`useGridStack`, `useWidgetSerializer`). CSS is 6.1 KB minified. No npm
provenance, which is common and not disqualifying here.

Its only npm script is `prepublishOnly`, which is not a lifecycle install
script, so it does not trip `scripts/check-install-scripts.js`. Verified: that
guard checks exactly `['preinstall', 'install', 'postinstall']` at line 33.

**No candidate toolkit ships a dashboard grid.** Verified across Vuetify (VGrid
is flexbox rows and columns, and its directive list has no drag), Quasar,
Element Plus, Naive UI, Reka UI, shadcn-vue, Nuxt UI, PrimeVue and BumbleVue.

**The grid choice is fully independent of the toolkit choice.** gridstack is
framework-agnostic with its own `.grid-stack` CSS, zero dependencies, and no
kit integration point, so it composes identically with every candidate. It did
not influence the toolkit decision and must not. **It can be adopted now,
before any toolkit work.**

Rejected: `grid-layout-plus` (Vue 3 native and MIT, but last release
2025-10-13 despite 21 commits since, so the release channel is stale. Single
maintainer, and it drags in interactjs plus two `@vexip-ui/*` packages from the same
author's separate UI library). `vue-grid-layout` is Vue 2 and last published
2022, dead for this stack.

Several components from the current anomaly page are candidates to become the
first widgets.

## Risks And Watch Points

- **Runtime theming is the feature most likely to break.** It is the least
  standardized thing across Vue UI kits and the 13-theme system is a visible,
  shipped feature. Prove it in a spike before committing.
- **Bus factor on a small fork.** The cheapest migration path is also the one
  with the most governance risk. Maturity, not compatibility, has been the
  blocker since July.
- **Supply chain.** Any candidate must pass the existing release gate:
  `npm ci --ignore-scripts` plus `scripts/check-install-scripts.js`, which fails
  the build if any staged dependency declares an install script. Re-run the
  fork-diff audit method from the July research on whatever is adopted.
- **Offline requirement.** Dependencies are bundled into a signed release
  tarball with no install-time npm. No CDN dependency is acceptable.
- **Tests that assert on source as text are fragile through all of this.** 19
  test files call `readFileSync`, and the client ones grep `.vue` source for
  literal substrings (13 such assertions). One already broke on the formatting
  sweep. The token rename in Phase 0b and the component swap in Phase 2 will
  each break more, and they fail in a way that looks like a real regression
  without being one. Prefer loosening them to whitespace-tolerant patterns as
  they break, and mutation test each loosening so it does not quietly stop
  asserting anything.
- **Do not mix this with a release.** Same reasoning as the Vite 8 plan: keep
  toolkit migration off the automatic dependency-update path.
- **Adopting OpenVue reintroduces a publish path, and this is the one genuine
  regression in the decision.** Staying on archived 4.5.5 has *zero* forward
  supply-chain exposure, because nothing new will ever be published to it.
  OpenVue restores a channel controlled by a single npm credential (njevric
  published every one of the 7 packages, despite 2 names on the ACL). Real but
  manageable: exact version pins, `npm ci --ignore-scripts` resolving against a
  lockfile with integrity hashes, and a malicious 1.0.1 cannot arrive without a
  deliberate bump. **The mitigation is a standing practice: re-run the fork-diff
  audit on every version bump.** The method is cheap, one pass of canonicalized
  md5 comparison against the equivalent PrimeVue 4.5.5 files.

## Measured Migration Cost

For Element Plus, against the surface measured above:

- 712 tag sites, of which roughly 520 are mechanical rename plus prop remap.
- `DataTable` and `Column` are 133 of those sites, and Element Plus preserves
  the structure, so they are renames rather than restructures.
- Tabs: 40 tags across the Tabs/TabList/Tab/TabPanels/TabPanel family collapse
  to 2 components over ~13 groups.
- `ContextMenu` 13 sites, new pattern.
- Toast: 9 tags, but `useToast` appears in 28 files. `client/src/ui/useToast.js`
  is already a one-line re-export, so an adapter there preserves the signature
  and those 28 files need no change.
- `v-tooltip`: 20 sites become markup.
- Tokens: **zero call sites need editing at this point**, because Phase 0b
  already moved all 755 of them onto `--cid-*`. The Element Plus move then
  edits one shim file, repointing `--cid-*` at Element Plus variables instead
  of `--p-*`. That is the entire return on Phase 0b.
- `:deep(.p-*)`: 24 selectors, 12 distinct patterns, mostly tabs and datatable.

Estimate: 3 to 5 focused days of editing plus 2 to 3 days of visual QA across
71 views. Call it 1.5 to 2 weeks calendar including review.

The client test suite is close to unaffected. Only 2 of 36 client test files
reference `.p-` or `--p-` at all, and both incidentally: one asserts the
*absence* of a token string in source, the other uses token names as fixture
literals, including `--p-dhcp-pool`, which exists nowhere in `client/src` and
is dead. Neither couples to vendor class names.

Phases 0a and 0b, for comparison, are measured rather than estimated:

| Phase | Files | Scale | Status |
|---|---|---|---|
| 0a Prettier sweep | 352 | +31681 / -12585 | **done**, `600aad4`..`b767e31` |
| 0b token rename | 57 | 819 lines | **done**, `b2fc290`..`9d1e8d8` |
| 2 OpenVue swap | 33 | import lines in `client/src/ui/` only | ready |

The OpenVue swap is 33 files because **zero files outside `client/src/ui/`
import from `primevue` or `@primeuix`**. The shim boundary is fully intact, so
the swap is confined to it.

## Open Questions

Toolkit selection and token naming are both resolved. What remains:

1. **Whether to take gridstack now**, ahead of any toolkit work. It is
   independent, settled, and the dashboard feature wants it regardless.
2. **Whether to adopt the dim scheme now**, since it is a change to our own
   theme store and does not wait on anything. See Phase 3.
3. **When to promote Element Plus.** The trigger is the 0.5.0 redesign reaching
   these views, not a date.
4. **Whether Phase 0b's rename should also normalize the 30 `--cid-*` tokens
   that already exist.** They are currently static hex, not theme aware, which
   is why chart colors do not follow the 13 themes. Fixing that is a real
   improvement but it is a behavior change, not a rename, so it does not belong
   in a blame-ignored commit.

## Decision Log

- **2026-07-24/25**: licensing settled, BumbleVue spike proven, supply-chain
  audit clean, verdict WAIT on maturity. See the memory reference file.
- **2026-09-12**: BumbleVue re-checked and rejected (1.0 shipped but adoption
  collapsing, single author, silent). Clean-break candidates benchmarked for the
  first time, Element Plus selected, Vuetify runner-up, Quasar rejected on
  theming. gridstack selected for the grid, independently.
- **2026-09-12, same day**: OpenVue surfaced by the maintainer after the first
  research pass missed it. Audited clean, governance found candid but thin,
  external PR merges confirmed as the decisive difference from BumbleVue.
  Selection changed to OpenVue near-term with Element Plus deferred, on cost and
  reversibility rather than project health.

- **2026-09-12, same day**: Prettier adopted, reversing the standing repo rule,
  and the CSS token decision flipped from Option A to `--cid-*`. Prettier went
  in on the all-or-nothing hook argument plus `.git-blame-ignore-revs` handling
  the blame objection the rule was built on. The token flip was forced by a
  finding rather than a preference: Option A would have redefined the `--p-*`
  tokens that OpenVue emits and that `updatePreset` rewrites at runtime, which
  `App.vue` already documents as the thing not to do.

- **2026-09-12, later**: Phase 0a and 0b both landed, 14 commits total. Two
  findings worth carrying forward. Prettier is **not idempotent** on this
  codebase (a method chain with an object-literal argument needs a second
  pass), so always run `npm run format` twice when bumping it. And the
  `git blame` damage that justified the old no-Prettier rule is far smaller
  than assumed: across 25 swept files only 15 lines end up attributed to the
  sweep, and `.git-blame-ignore-revs` redirects none of them, because the lines
  that do land there are genuinely new. The token rename is the case where
  blame-ignoring actually earns its keep, since a one-token edit inside 819
  existing lines does move authorship.

## References

- `memory/reference_primevue_license_and_replacements.md`: licensing facts, the
  BumbleVue drop-in spike, and the supply-chain audit. All settled, do not redo.
- `docs/VITE-8-MIGRATION-PLAN.md`: precedent for keeping a toolchain migration
  off the release path.
- `client/src/ui/README.md`: the component shim convention.
