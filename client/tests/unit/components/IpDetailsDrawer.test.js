/**
 * The liveness row of the IP details drawer.
 *
 * This is the payoff for having a component harness at all: the bug was in a
 * template, not a util. The row used to be three inline
 * `host.is_online ? 'Online' : 'Offline'` ternaries, so the STRING '0' rendered
 * as Online (non-empty strings are truthy) and an address with no liveness
 * information rendered as Offline rather than unknown.
 *
 * See REVIEW.md, duplicate-logic audit #48.
 */
import { describe, it, expect, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../../../src/api/client.js', () => ({
  default: { get: apiGet, delete: vi.fn() }
}));

// PrimeVue's toast is injected by the app, not by a bare mount.
vi.mock('primevue/usetoast', () => ({ useToast: () => ({ add: vi.fn() }) }));

const IpDetailsDrawer = (await import('../../../src/components/IpDetailsDrawer.vue')).default;

// Render the drawer body inline so its content is in the DOM without PrimeVue's
// overlay/teleport machinery. StatusDot is kept real: its label is part of what
// the accessibility story depends on, so stubbing it would hide a regression.
const mountDrawer = (host) => mount(IpDetailsDrawer, {
  props: { visible: true, host },
  global: {
    stubs: {
      Drawer: {
        props: ['dismissable', 'style'],
        template: '<aside :data-dismissable="dismissable" :data-width="style && style.width"><slot /></aside>'
      },
      Button: true,
      Tag: { props: ['value'], template: '<span class="event-tag">{{ value }}</span>' },
    },
  },
});

// Read the VALUE span, not the whole row: the row's label is itself the word
// "Online", so asserting on row text cannot tell the label from the value.
function livenessText(w) {
  const row = w.findAll('.hi-row').find(r => r.find('.hi-label')?.text() === 'Online');
  return row ? row.find('.hi-val').text() : null;
}

describe('IpDetailsDrawer liveness row', () => {
  it('uses the reduced desktop width while retaining the mobile viewport cap', () => {
    const w = mountDrawer({ ip_address: '10.0.0.5', is_online: false });
    expect(w.find('aside').attributes('data-width')).toBe('min(27rem, 92vw)');
  });

  it('dismisses the non-modal drawer when the user clicks outside it', () => {
    const w = mountDrawer({ ip_address: '10.0.0.5', is_online: false });
    expect(w.find('aside').attributes('data-dismissable')).toBe('true');
  });

  it('renders Online for every online spelling, including the string', () => {
    for (const v of [true, 1, '1']) {
      expect(livenessText(mountDrawer({ ip_address: '10.0.0.5', is_online: v })), `is_online=${JSON.stringify(v)}`)
        .toContain('Online');
    }
  });

  it("renders Offline for the STRING '0', which the inline ternary got wrong", () => {
    const text = livenessText(mountDrawer({ ip_address: '10.0.0.5', is_online: '0' }));
    expect(text).toContain('Offline');
    // The value must not read as Online. StatusDot's label is in here too, so
    // check the whole value span rather than a substring of the row.
    expect(text.replace(/Offline/g, '')).not.toContain('Online');
  });

  it('renders Offline for the other offline spellings', () => {
    for (const v of [false, 0]) {
      expect(livenessText(mountDrawer({ ip_address: '10.0.0.5', is_online: v })), `is_online=${JSON.stringify(v)}`)
        .toContain('Offline');
    }
  });

  it('shows unknown rather than Offline when liveness was never observed', () => {
    const text = livenessText(mountDrawer({ ip_address: '10.0.0.5', is_online: null }));
    expect(text).not.toContain('Offline');
    expect(text).toContain('—');
  });

  it('does not fall over when host is null', () => {
    const w = mount(IpDetailsDrawer, {
      props: { visible: true, host: null },
      global: { stubs: { Drawer: { template: '<aside><slot /></aside>' }, Button: true, Tag: true } },
    });
    expect(w.exists()).toBe(true);
  });

  it('loads lifecycle events and refreshes them when another IP is selected', async () => {
    apiGet.mockResolvedValueOnce({
      data: {
        events: [{
          id: 7,
          event_type: 'online',
          created_at: '2026-09-05T12:00:00Z',
          source: 'scanner'
        }]
      }
    });

    const w = mount(IpDetailsDrawer, {
      props: {
        visible: true,
        host: { ip_address: '10.0.0.72', is_online: true },
        subnetId: 2
      },
      global: {
        stubs: {
          Drawer: { template: '<aside><slot /></aside>' },
          Button: true,
          Tag: { props: ['value'], template: '<span class="event-tag">{{ value }}</span>' }
        }
      }
    });
    await flushPromises();

    expect(apiGet).toHaveBeenCalledWith('/subnets/2/ips/10.0.0.72/events');
    expect(w.find('.lifecycle-section').text()).toContain('IP lifecycle');
    expect(w.find('.events-list').text()).toContain('Online');
    expect(w.find('.events-list').text()).toContain('(active scan)');

    apiGet.mockResolvedValueOnce({
      data: {
        events: [{
          id: 8,
          event_type: 'offline',
          created_at: '2026-09-05T13:00:00Z',
          source: 'stale'
        }]
      }
    });
    await w.setProps({ host: { ip_address: '10.0.0.73', is_online: false } });
    await flushPromises();

    expect(apiGet).toHaveBeenCalledWith('/subnets/2/ips/10.0.0.73/events');
    expect(w.find('.events-list').text()).toContain('Offline');
    expect(w.find('.events-list').text()).toContain('(staleness timeout)');
  });
});
