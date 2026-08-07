# Cross-tier duplication: which strategy, and when

When one rule has to exist on both sides of a boundary a normal `import` cannot
cross, there are only three honest options. This note picks between them once, so
we are not re-litigating it per case. The boundaries in this codebase are
server JS to client JS, bash to JS, JS to SQL, and JS to generated dnsmasq config.

Background and the full finding list: `REVIEW.md`, duplicate-logic audit
(2026-08-06/07). This note covers only the cross-tier findings, roughly a dozen of
the sixty. In-tier duplication needs no policy: a shared helper already exists or
can be made, so just use it. `scripts/check-duplicate-exports.js` guards the
common relapse.

## The rule

Pick the first option that applies.

### 1. Serve it from the API

**When**: the duplicated thing is a catalog, a default, or a policy the server
already owns. Anything the client is currently hardcoding a copy of.

**Why first**: it removes the second implementation entirely rather than keeping
it in step. The server stays the single source and the client renders whatever it
is told.

**The trap to avoid**: a client-side fallback literal for when the fetch fails.
That fallback IS the duplicate, and it is where the drift lands, because nobody
reviews the sad path. If the fetch fails, the UI should refuse to offer the
control rather than invent a value. Finding #38 is exactly this: five of six SOA
fields match across three tiers and only `soa_minimum_ttl` drifted, in the
catch-block fallback.

**Applies to**: SOA defaults (#38), the DNS record-type catalog, custom DHCP
option types and code range, the role catalog in `Users.vue` (#40), the
setup-wizard password policy (#39). The DoH provider catalog and the DHCP option
catalog already do this correctly and are the model to copy.

### 2. Extract a shared module

**When**: it is pure logic with no I/O, both sides are JavaScript, and the
behavior genuinely must be identical rather than merely similar.

**Cost, which is why this is not first**: a module imported by both packages has
to be resolvable by Vite, staged into the release tarball, and known to
`scripts/check-staging-imports.js`. That is real plumbing and it is easy to get
wrong in a way that only shows up in a built artifact.

**Applies to**: the `server/src/utils/ip.js` and `client/src/utils/ip.js` pair
(#3), which is the strongest candidate in the codebase: 12 shared exports, pure
arithmetic, five already divergent. Nothing else currently clears the bar.

**Before doing it**, settle the semantics rather than picking a side at random.
The client copy is not simply a stale server copy: `calculateSubnets` returns
strings on one side and parsed objects on the other, so they were never the same
function. Decide the contract first, migrate callers, then delete the loser.

### 3. Keep both, and make drift fail the build

**When**: the boundary genuinely cannot be crossed. bash cannot import JS. SQLite
cannot import a JS array. A CHECK constraint is a real last line of defence and
should stay even if a JS validator also exists.

**The price of keeping a pair is a differential test.** Same fixture table through
both implementations, asserting identical verdicts. Two exist:

- `server/tests/unit/utils/semver-differential.test.js` (bash and JS)
- `server/tests/integration/schema-enum-differential.test.js` (JS and SQL CHECK,
  read out of `sqlite_master` after migrations, not out of the migration text)

**Applies to**: semver (#2, done), the role and record-type CHECK constraints
(#40, roles done), the active-lease predicate (#26), the web-port fallback
constants shared with `install.sh` and the systemd unit.

**If nobody wants to write the test, that is the signal the pair should not be
kept.** Go back to option 1 or 2.

## What does not count as cross-tier duplication

A client sending a value the server validates is normal layering, not
duplication. It only becomes duplication when the client independently
reimplements the *rule*, such as re-declaring the IPv4 regex instead of importing
the shared one.

Defence in depth is not duplication either, as long as the inner layer is
strictly weaker and sits at the actual sink. The dnsmasq writers re-checking
values the DNS routes already validated (#F11) is deliberate and correct: the
route is stricter, the writer is a backstop against rows written by anything
other than the API. Do not deduplicate that.

## Sequencing

Options 1 and 3 change no behavior on the happy path and are safe any time.
Option 2 touches display logic and validation, so it waits until the current
release ships.

The failure this whole note exists to prevent is not the duplication itself, it
is that nothing currently fails when two implementations of one rule drift apart.
Three of the worst findings in the audit were in modules created that same week
to eliminate duplication. Prefer whichever option makes the next drift loud.
