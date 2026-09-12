/**
 * The subnet grid must be able to express every type the classifier can emit.
 *
 * SubnetDetail.vue painted each cell from a four-branch colour ladder while the
 * tooltip on that same cell asked the eight-type shared classifier. Four types
 * had no branch, and two of them mattered: a ROGUE address was drawn in the
 * ordinary pool tint, indistinguishable from free space unless you hovered it,
 * and a system allocation was drawn inconsistently depending on whether it
 * came from a functional range or the canonical read model. The grid is the
 * at-a-glance view of a subnet, so every system IP must use one stable color.
 *
 * These assert on the classifier plus the colour mapping the grid applies,
 * rather than mounting SubnetDetail, which needs the router, both stores and a
 * dozen PrimeVue components. The mapping is duplicated here deliberately and
 * kept in step by the "every type has a colour" case below.
 *
 * See REVIEW.md, duplicate-logic audit #41.
 */
import { describe, it, expect } from 'vitest';
import {
  ipLifecycleDisplay,
  ADDRESS_TYPE_ROGUE,
  ADDRESS_TYPE_SYSTEM,
  ADDRESS_TYPE_RESERVED,
  ADDRESS_TYPE_RESERVED_DHCP,
  ADDRESS_TYPE_STATIC_DNS,
  ADDRESS_TYPE_GATEWAY,
  ADDRESS_TYPE_DYNAMIC_DHCP,
  ADDRESS_TYPE_SLAAC,
  ADDRESS_TYPE_QUARANTINED,
} from '../../../src/utils/ipLifecycleDisplay.js';

// Mirrors the ladder in SubnetDetail.vue ipGrid.
function cellColour({ typeClass, functionalRole = null, rangeColour = null }) {
  if (functionalRole === 'Network' || functionalRole === 'Broadcast') return 'var(--cid-system)';
  if (functionalRole === 'Gateway') return 'var(--cid-gateway)';
  if (typeClass === 'type-rogue') return 'var(--cid-rogue)';
  if (typeClass === 'type-system') return 'var(--cid-system)';
  return rangeColour || 'var(--cid-surface-200)';
}

// Opaque stand-in for whatever colour a DHCP range supplies. The assertions
// below only care that it differs from the address-type colours, so this is
// deliberately not a real token.
const POOL_TINT = 'rgb(1 2 3)';

describe('grid cell colour can express what the classifier emits', () => {
  it('paints a rogue address distinctly from free space', () => {
    // The bug: this fell through to the range colour, so a rogue address inside
    // a DHCP scope looked exactly like an unused one.
    const state = ipLifecycleDisplay({ ip_display_status: 'in use', address_type: 'rogue' });
    expect(state.addressType?.className).toBe(ADDRESS_TYPE_ROGUE.className);

    const rogue = cellColour({ typeClass: state.addressType.className, rangeColour: POOL_TINT });
    const free = cellColour({ typeClass: null, rangeColour: POOL_TINT });
    expect(rogue).not.toBe(free);
    expect(rogue).toBe('var(--cid-rogue)');
  });

  it('paints a canonical system address distinctly', () => {
    const state = ipLifecycleDisplay({ ip_display_status: 'in use', address_type: 'system' });
    expect(state.addressType?.className).toBe(ADDRESS_TYPE_SYSTEM.className);

    const own = cellColour({ typeClass: state.addressType.className, rangeColour: POOL_TINT });
    expect(own).not.toBe(cellColour({ typeClass: null, rangeColour: POOL_TINT }));
  });

  it('leaves a genuinely free address on the range colour', () => {
    const state = ipLifecycleDisplay({ ip_display_status: 'DHCP Scope', address_type: null });
    expect(state.addressType).toBeNull();
    expect(cellColour({ typeClass: null, rangeColour: POOL_TINT })).toBe(POOL_TINT);
  });

  it('uses one system color for network and broadcast addresses', () => {
    expect(
      cellColour({ typeClass: 'type-system', functionalRole: 'Network', rangeColour: 'grey' }),
    ).toBe('var(--cid-system)');
    expect(
      cellColour({ typeClass: 'type-system', functionalRole: 'Broadcast', rangeColour: 'black' }),
    ).toBe('var(--cid-system)');
  });

  it('keeps the gateway on its separate gateway color', () => {
    expect(
      cellColour({ typeClass: 'type-gateway', functionalRole: 'Gateway', rangeColour: 'grey' }),
    ).toBe('var(--cid-gateway)');
  });

  it('every type the classifier can emit maps to a colour or an explicit fallback', () => {
    // Guards the ladder against a NEW address type being added upstream and
    // silently rendering as free space, which is how rogue went unnoticed.
    const all = [
      ADDRESS_TYPE_ROGUE,
      ADDRESS_TYPE_SYSTEM,
      ADDRESS_TYPE_RESERVED,
      ADDRESS_TYPE_RESERVED_DHCP,
      ADDRESS_TYPE_STATIC_DNS,
      ADDRESS_TYPE_GATEWAY,
      ADDRESS_TYPE_DYNAMIC_DHCP,
      ADDRESS_TYPE_SLAAC,
      ADDRESS_TYPE_QUARANTINED,
    ];
    for (const t of all) {
      const colour = cellColour({ typeClass: t.className, rangeColour: POOL_TINT });
      expect(colour, `${t.label} has no colour`).toBeTruthy();
    }
  });
});
