# Networks workspace model tests

The Networks workspace has many independent pieces of state. Most of its
"I clicked this, then that, and something odd happened" bugs live where two of
them meet. These tests explore those combinations mechanically instead of one
report at a time.

## The partition

**State.** What the screen can be in, each dimension read back from the DOM by
`harness.js` (`observe`):

| Dimension | Values |
| --- | --- |
| Place | All Allocated Networks, All Unallocated Networks, a folder (Ungrouped included), a network |
| View | the place's tabs: Networks/DNS/DHCP, or Addresses/DNS/DHCP/Ranges, or none |
| DNS choice | a zone card, a zone in the reverse picker, or one network's reverse zones |
| DHCP choice | a scope card or none |
| Searches | explorer search, table search |
| Toggles | Show available, Show hierarchy, folders expanded |
| Selection | checked rows, the open details panel |
| Persistence | what a reload brings back |

**Actions.** Everything a person can click or type there, in `driver.js`, as
short labels (`network 13 ctrl`, `pick-zone 202`, `search "lab"`, `reload`).
`candidates()` lists only what the screen currently offers.

**Data.** `fake-estate.js` is a small estate built to hit the awkward cases:

- two folders and Ungrouped;
- a /23 with two reverse zones;
- a divided unallocated /24;
- a leftover disabled reverse zone and an enabled standalone one;
- a network with only a reverse zone;
- a generated record, a disabled record and a disabled scope.

It answers the workspace's reads with the same filtering as the server.

## The invariants

Checked after every step (`violations` in `harness.js`):

1. The header names a place, and the explorer marks that place and nothing
   else (unless a search hides its row).
2. Each place has its tabs, and one of them is open.
3. The DNS view always has exactly one choice when there are zones to choose
   from, and the chosen zone has a lit card.
4. The zone and scope cards are the place's zones and scopes that match the
   search; two or more reverse zones fold into the picker.
5. The table's rows are exactly what the estate returns for the place, choice
   and searches (DNS records, DHCP rows, networks, or addresses inside the
   network).
6. A network checked in the table is checked in the explorer, and the
   reverse.
7. No unknown request, console error, Vue warning or load error.
8. At the end of each walk, a reload brings back the same place, view, choice,
   search, toggles and rows.

## Running it

```bash
npm test                  # 12 short walks plus the regressions, every run
npm run hunt:workspace    # 300 longer walks; MODEL_SEEDS, MODEL_FIRST_SEED, MODEL_STEPS tune it
```

A failing walk is shrunk automatically to the fewest steps that still fail the
same way. The failure prints a ready-to-paste `walk([...])`. Add that walk to
`regressions.test.js` with a name saying what should happen, fix the bug, and
check that the test fails without the fix.

When the workspace gains a control, add its action to `driver.js`. When it
gains a rule about what the screen should show, add the rule to `violations`.
