/**
 * The liveness row of the host popup.
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
import { mount } from '@vue/test-utils';

// PrimeVue's toast is injected by the app, not by a bare mount.
vi.mock('primevue/usetoast', () => ({ useToast: () => ({ add: vi.fn() }) }));

const HostInfoDialog = (await import('../../../src/components/HostInfoDialog.vue')).default;

// Render the dialog body inline so its content is in the DOM without PrimeVue's
// overlay/teleport machinery. StatusDot is kept real: its label is part of what
// the accessibility story depends on, so stubbing it would hide a regression.
const mountDialog = (host) => mount(HostInfoDialog, {
  props: { visible: true, host },
  global: {
    stubs: {
      Dialog: { template: '<div><slot /></div>' },
      Button: true,
    },
  },
});

// Read the VALUE span, not the whole row: the row's label is itself the word
// "Online", so asserting on row text cannot tell the label from the value.
function livenessText(w) {
  const row = w.findAll('.hi-row').find(r => r.find('.hi-label')?.text() === 'Online');
  return row ? row.find('.hi-val').text() : null;
}

describe('HostInfoDialog liveness row', () => {
  it('renders Online for every online spelling, including the string', () => {
    for (const v of [true, 1, '1']) {
      expect(livenessText(mountDialog({ ip_address: '10.0.0.5', is_online: v })), `is_online=${JSON.stringify(v)}`)
        .toContain('Online');
    }
  });

  it("renders Offline for the STRING '0', which the inline ternary got wrong", () => {
    const text = livenessText(mountDialog({ ip_address: '10.0.0.5', is_online: '0' }));
    expect(text).toContain('Offline');
    // The value must not read as Online. StatusDot's label is in here too, so
    // check the whole value span rather than a substring of the row.
    expect(text.replace(/Offline/g, '')).not.toContain('Online');
  });

  it('renders Offline for the other offline spellings', () => {
    for (const v of [false, 0]) {
      expect(livenessText(mountDialog({ ip_address: '10.0.0.5', is_online: v })), `is_online=${JSON.stringify(v)}`)
        .toContain('Offline');
    }
  });

  it('shows unknown rather than Offline when liveness was never observed', () => {
    const text = livenessText(mountDialog({ ip_address: '10.0.0.5', is_online: null }));
    expect(text).not.toContain('Offline');
    expect(text).toContain('—');
  });

  it('does not fall over when host is null', () => {
    const w = mount(HostInfoDialog, {
      props: { visible: true, host: null },
      global: { stubs: { Dialog: { template: '<div><slot /></div>' }, Button: true } },
    });
    expect(w.exists()).toBe(true);
  });
});
