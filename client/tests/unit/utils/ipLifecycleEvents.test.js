import { describe, expect, it } from 'vitest';
import {
  EVENT_TONE_SEVERITY,
  eventDetail,
  eventActorLabel,
  eventLabel,
  eventSourceLabel,
  eventTone,
} from '../../../src/utils/ipLifecycleEvents.js';

// Shared by IpDetailsDrawer.vue (current interface) and
// AddressDetailsPanel.vue (workspace). Both must read a history row the same
// way, so the contract is pinned here rather than in either component test.

describe('eventLabel', () => {
  it('names every event type the server emits', () => {
    // Emitters: models/ip-address.js, utils/ip-sync.js,
    // services/ip-lifecycle-service.js. status_changed is legacy and only
    // appears on rows written before ip_addresses.status was removed.
    const emitted = [
      'online',
      'offline',
      'scanned',
      'rogue_detected',
      'rogue_cleared',
      'dns_added',
      'dns_removed',
      'lease_obtained',
      'hostname_changed',
      'mac_changed',
      'allocation_changed',
      'status_changed',
      'scan_enabled_changed',
      'retired',
    ];
    for (const type of emitted) {
      expect(eventLabel(type), type).not.toBe(type);
      expect(eventLabel(type), type).not.toContain('_');
    }
  });

  it('calls retirement Metadata Expired, never a release', () => {
    // A scope-only address keeps status DHCP Scope after retirement; only its
    // learned metadata is gone. The label must not read as an allocation event.
    expect(eventLabel('retired')).toBe('Metadata Expired');
    expect(eventLabel('retired').toLowerCase()).not.toMatch(/releas|unassign|free/);
  });

  it('labels scope events without implying allocation', () => {
    expect(eventLabel('scope_added')).toBe('Added to DHCP Scope');
    expect(eventLabel('scope_removed')).toBe('Removed from DHCP Scope');
    expect(eventLabel('scope_membership_changed')).toBe('DHCP Scope membership changed');
    expect(eventLabel('unknown_event')).toBe('unknown event');
    expect(eventLabel(undefined)).toBe('Event');
    expect(eventLabel('')).toBe('Event');
  });
});

describe('eventTone', () => {
  it('separates the five tones and maps each to a Tag severity', () => {
    expect(eventTone('online')).toBe('good');
    expect(eventTone('rogue_detected')).toBe('danger');
    expect(eventTone('rogue_cleared')).toBe('warn');
    expect(eventTone('retired')).toBe('muted');
    expect(eventTone('hostname_changed')).toBe('info');
    expect(eventTone('anything_else')).toBe('info');
    for (const tone of ['good', 'danger', 'warn', 'muted', 'info']) {
      expect(EVENT_TONE_SEVERITY[tone], tone).toBeTruthy();
    }
  });
});

describe('eventDetail', () => {
  it('renders old to new with a human source label', () => {
    expect(eventDetail({ old_value: 'printer', new_value: 'printer-2', source: 'scanner' })).toBe(
      'printer → printer-2 · via active scan',
    );
  });

  it('drops whichever parts the row lacks', () => {
    expect(eventDetail({ new_value: 'host.example' })).toBe('host.example');
    expect(eventDetail({ old_value: 'host.example', source: 'dns' })).toBe(
      'host.example · via DNS',
    );
    expect(eventDetail({ source: 'retirement' })).toBe('via automatic cleanup');
    expect(eventDetail({})).toBe('');
  });

  it('renders a scope-membership retirement as metadata cleanup', () => {
    // The row the A-06 test cares about: retired, source retirement, no
    // values. The panel prints the label and this detail side by side.
    const row = { event_type: 'retired', source: 'retirement' };
    expect(`${eventLabel(row.event_type)}: ${eventDetail(row)}`).toBe(
      'Metadata Expired: via automatic cleanup',
    );
  });

  it('spaces an unknown source instead of showing raw underscores', () => {
    expect(eventSourceLabel('lease_sync')).toBe('lease sync');
    expect(eventSourceLabel(null)).toBe('');
  });

  it('shows a recorded actor but does not invent one', () => {
    expect(eventActorLabel({ actor_name: 'Administrator' })).toBe('Administrator');
    expect(eventDetail({ new_value: 'reserved', actor_name: 'Administrator' })).toBe(
      'reserved · by Administrator',
    );
    expect(eventActorLabel({})).toBe('');
    expect(eventDetail({ new_value: 'reserved' })).toBe('reserved');
  });
});
