# `client/src/ui/`, the widget-library seam

Every vendor component, service, directive and theming call the app uses is
re-exported from exactly one module here. **Application code must not import
`primevue/*` or `@primeuix/themes` directly.** Import from `../ui/X` instead.

## Why

PrimeVue was archived read-only on 2026-06-28 and relicensed from v5. CIDRella
stays on 4.5.5, which is MIT forever (a relicense is not retroactive), so there
is no licensing exposure, but a frozen dependency gets no security patches. The
plan is to move to an API-compatible community fork.

This directory exists for two reasons, and the second is the important one:

1. The vendor's name appears in `ui/` and nowhere else, so a swap is a small,
   reviewable diff instead of 276 edits across 44 files.
2. **It is a place to absorb API drift.** A fork will not match the original
   forever. When one diverges, the shim goes in `ui/Popover.js` rather than in
   the five files that call `.toggle()` imperatively.

## Why one file per component, and not a barrel

A single `index.js` re-exporting all 29 components would be tidier to import
from, and it is deliberately not what this is.

Vendor components register their styles as a side effect, and side effects
defeat Rollup's tree-shaking of re-export barrels. A barrel therefore risks
pulling every component into any chunk that touches it, collapsing the build's
code splitting. At the time of writing that build is 62 chunks / 1.77MB with a
248K shared `column` chunk carrying DataTable, which is exactly the thing a
barrel would flatten.

One module per component keeps the module boundary by construction, so the
chunking is unchanged. If a barrel is ever wanted for ergonomics, measure the
chunk count and total JS before and after, and do not take it on faith.

## What is deliberately NOT here

The ~650 `--p-*` design-token references in the app's CSS. The intended fork
emits the same tokens and the same `p-*` classes, so rewriting them would be a
large diff with real visual-regression risk and no benefit. That work only
becomes worthwhile if CIDRella ever moves to a library outside this family.
