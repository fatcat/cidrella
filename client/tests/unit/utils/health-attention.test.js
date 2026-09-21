import { describe, expect, it } from 'vitest';
import {
  ATTENTION_ROUTES,
  attentionItems,
  openCount,
} from '../../../src/utils/health-attention.js';

const healthy = {
  services: { dnsmasq: true, geoip_proxy: true },
  lifecycle: {
    rogue_hosts: 0,
    scope_conflicts: 0,
    reconciliation: { outcome: 'complete', failures: 0, blocking_conflicts: 0 },
  },
  networkDhcp: { summary: { review_required: 0, safe_repairs: 0 } },
  rogueDhcp: { enabled: true, healthy: true, unacknowledged: 0 },
  anomalies: { unacknowledged_active: 0, by_severity: {} },
};

describe('attentionItems', () => {
  it('yields nothing for a healthy snapshot and nothing for an empty one', () => {
    expect(attentionItems(healthy)).toEqual([]);
    expect(attentionItems({})).toEqual([]);
  });

  it('orders err before warn before muted, keeping source order within a tone', () => {
    const rows = attentionItems({
      ...healthy,
      services: { dnsmasq: false },
      lifecycle: { ...healthy.lifecycle, rogue_hosts: 29, scope_conflicts: 2 },
      rogueDhcp: {
        enabled: true,
        healthy: false,
        unacknowledged: 1,
        lastProbeError: 'cannot bind UDP :68 (EACCES)',
      },
      anomalies: { unacknowledged_active: 29, by_severity: { low: 29 } },
      networkDhcp: { summary: { review_required: 1, safe_repairs: 2 } },
    });
    expect(rows.map((r) => `${r.tone}:${r.id}`)).toEqual([
      'err:dnsmasq-down',
      'err:scope-conflicts',
      'warn:rogue-dhcp',
      'warn:rogue-hosts',
      'warn:anomalies',
      'warn:dhcp-review',
      'muted:rogue-probe',
    ]);
    expect(openCount(rows)).toBe(6);
    expect(rows.find((r) => r.id === 'rogue-probe').detail).toContain('cannot bind UDP :68');
    expect(rows.find((r) => r.id === 'dhcp-review').detail).toBe('2 more can be repaired safely');
  });

  it('links each row to the page where it is acted on', () => {
    const rows = attentionItems({
      ...healthy,
      lifecycle: { ...healthy.lifecycle, rogue_hosts: 3 },
      rogueDhcp: { enabled: true, healthy: true, unacknowledged: 2 },
      anomalies: { unacknowledged_active: 1, by_severity: { low: 1 } },
    });
    expect(rows.find((r) => r.id === 'rogue-dhcp')).toMatchObject({
      title: 'Rogue DHCP servers',
      count: 2,
      to: ATTENTION_ROUTES.rogueDhcp,
    });
    expect(rows.find((r) => r.id === 'rogue-hosts').to).toBe(ATTENTION_ROUTES.rogueHosts);
    expect(rows.find((r) => r.id === 'anomalies').to).toBe(ATTENTION_ROUTES.anomalies);
  });

  it('escalates anomalies to err when any device is high or critical', () => {
    const [row] = attentionItems({
      ...healthy,
      anomalies: { unacknowledged_active: 4, by_severity: { low: 2, high: 1, critical: 1 } },
    });
    expect(row).toMatchObject({
      id: 'anomalies',
      tone: 'err',
      detail: '2 flagged high or critical',
    });
  });

  it('flags reconciliation that did not complete', () => {
    const [row] = attentionItems({
      ...healthy,
      lifecycle: {
        ...healthy.lifecycle,
        reconciliation: { outcome: 'blocked', failures: 0, blocking_conflicts: 3 },
      },
    });
    expect(row).toMatchObject({ id: 'reconciliation', tone: 'err', detail: '3 blocking' });
  });

  it('shows safe repairs alone as a muted row', () => {
    const [row] = attentionItems({
      ...healthy,
      networkDhcp: { summary: { review_required: 0, safe_repairs: 1 } },
    });
    expect(row).toMatchObject({ id: 'dhcp-review', tone: 'muted', count: 1 });
    expect(row.detail).toBe('1 issue can be repaired safely');
  });
});
