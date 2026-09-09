import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(
  path.resolve(TEST_DIR, '../../../src/views/SubnetDetail.vue'),
  'utf8'
);
const appSource = fs.readFileSync(
  path.resolve(TEST_DIR, '../../../src/App.vue'),
  'utf8'
);

describe('SubnetDetail grid interactions', () => {
  it('opens the shared IP details drawer from a grid-cell click without a hover tooltip', () => {
    expect(source).toContain('class="ip-cell ip-detail-trigger"');
    expect(source).toContain('@click="onGridCellClick($event, ip)"');
    expect(source).toContain('openIpDetails(ip.detailsRow');
    expect(source).not.toContain('v-tooltip.top="gridTooltip(ip)"');
  });

  it('gives the grid menu a static selection header and concise reservation action', () => {
    expect(source).toContain('showSelectionHeader: true');
    expect(source).toContain("conciseReservationLabel ? 'Create IP Reservation'");
    expect(source).toMatch(/showSelectionHeader[\s\S]*disabled: true/);
  });

  it('preserves cell colors and uses the theme-aware selection outline', () => {
    expect(source).toContain(':style="{ background: ip.color }"');
    expect(source).not.toContain("gridSelection.has(idx) ? 'var(--p-primary-200)'");
    expect(source).toContain('outline: 3px solid var(--cid-grid-selection)');
    expect(appSource).toContain('--cid-grid-selection: var(--cid-status-warn)');
  });

  it('uses one dark gray system token for every theme and both topology roles', () => {
    const definitions = [...appSource.matchAll(/--cid-system:\s*([^;]+);/g)]
      .map(match => match[1].trim());
    expect(definitions).toEqual(['#6b7280']);
    expect(source).toContain("['Network', 'Broadcast'].includes(functionalRangeInfo?.rangeType)");
    expect(source).toContain("if (isSystemAddress) cellColor = 'var(--cid-system)'");
  });
});
