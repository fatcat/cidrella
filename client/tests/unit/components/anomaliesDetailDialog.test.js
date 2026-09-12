/**
 * The detail dialog on the anomaly triage preview.
 *
 * The detail card exists only while the dialog is open: there is no copy of it
 * on the page underneath. So the things worth pinning down are that a row click
 * and a Detail click do different things, that stepping stays inside the queue
 * rather than wrapping or running off the end, and that every advertised way
 * out actually closes it.
 *
 * Sample mode throughout: its devices are literals in the component, so none
 * of this depends on the API.
 */
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = { get: vi.fn(() => Promise.resolve({ data: {} })), post: vi.fn(), put: vi.fn() };
vi.mock('../../../src/api/client.js', () => ({ default: api }));

const { default: AnomaliesWorkspacePreview } = await import('../../../src/views/AnomaliesWorkspacePreview.vue');

function mountPreview() {
  return mount(AnomaliesWorkspacePreview, {
    attachTo: globalThis.document.body,
    global: {
      plugins: [createPinia()],
      stubs: { 'router-link': { template: '<a><slot /></a>' } },
    },
  });
}

const isOpen = w => w.find('.board.as-modal').exists();
const position = w => w.find('.detail-pos').text();
const shownDevice = w => w.find('.entity-head h3').text();
const navButton = (w, label) => w.findAll('.nav-button').find(b => b.text().includes(label));

beforeEach(() => vi.clearAllMocks());

describe('anomaly detail dialog', () => {
  it('starts with no detail card on the page at all', () => {
    const wrapper = mountPreview();
    expect(isOpen(wrapper)).toBe(false);
    expect(wrapper.find('.entity-panel').exists()).toBe(false);
    expect(wrapper.find('.detail-backdrop').exists()).toBe(false);
    expect(wrapper.find('.detail-nav').exists()).toBe(false);
  });

  it('opens on the Detail button showing the device belonging to that row', async () => {
    const wrapper = mountPreview();
    const thirdRowName = wrapper.findAll('.queue-item')[2].find('.row-who b').text();
    await wrapper.findAll('.row-detail')[2].trigger('click');
    expect(isOpen(wrapper)).toBe(true);
    expect(shownDevice(wrapper)).toBe(thirdRowName);
    expect(position(wrapper)).toBe('3 of 6');
  });

  it('leaves the dialog shut when the row itself is clicked, which only reselects', async () => {
    const wrapper = mountPreview();
    await wrapper.findAll('.queue-row')[2].trigger('click');
    expect(isOpen(wrapper)).toBe(false);
    expect(wrapper.find('.entity-panel').exists()).toBe(false);
    expect(wrapper.find('.queue-item.current .row-who b').text())
      .toBe(wrapper.findAll('.queue-item')[2].find('.row-who b').text());
  });

  it('steps forward and back through the queue, keeping the queue selection in step', async () => {
    const wrapper = mountPreview();
    await wrapper.findAll('.row-detail')[0].trigger('click');
    await navButton(wrapper, 'Next').trigger('click');
    expect(position(wrapper)).toBe('2 of 6');
    expect(wrapper.find('.queue-item.current .row-who b').text()).toBe(shownDevice(wrapper));
    await navButton(wrapper, 'Previous').trigger('click');
    expect(position(wrapper)).toBe('1 of 6');
  });

  it('stops at the last device instead of wrapping to the first', async () => {
    const wrapper = mountPreview();
    await wrapper.findAll('.row-detail')[0].trigger('click');
    for (let i = 0; i < 10; i++) await navButton(wrapper, 'Next').trigger('click');
    expect(position(wrapper)).toBe('6 of 6');
    expect(navButton(wrapper, 'Next').attributes('disabled')).toBeDefined();
    expect(navButton(wrapper, 'Previous').attributes('disabled')).toBeUndefined();
  });

  it('stops at the first device instead of wrapping to the last', async () => {
    const wrapper = mountPreview();
    await wrapper.findAll('.row-detail')[3].trigger('click');
    for (let i = 0; i < 10; i++) await navButton(wrapper, 'Previous').trigger('click');
    expect(position(wrapper)).toBe('1 of 6');
    expect(navButton(wrapper, 'Previous').attributes('disabled')).toBeDefined();
  });

  // The disabled buttons stop a click before it reaches stepDetail, so they
  // hide whether stepDetail itself is bounded. The arrow keys have no such
  // gate and go straight in, which makes them the only way to prove it.
  it('holds at the last device when the right arrow is pressed past the end', async () => {
    const wrapper = mountPreview();
    await wrapper.findAll('.row-detail')[5].trigger('click');
    expect(position(wrapper)).toBe('6 of 6');
    for (let i = 0; i < 3; i++) {
      globalThis.window.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'ArrowRight' }));
      await flushPromises();
    }
    expect(position(wrapper)).toBe('6 of 6');
  });

  it('holds at the first device when the left arrow is pressed past the start', async () => {
    const wrapper = mountPreview();
    await wrapper.findAll('.row-detail')[0].trigger('click');
    for (let i = 0; i < 3; i++) {
      globalThis.window.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'ArrowLeft' }));
      await flushPromises();
    }
    expect(position(wrapper)).toBe('1 of 6');
  });

  it('closes on the X', async () => {
    const wrapper = mountPreview();
    await wrapper.findAll('.row-detail')[1].trigger('click');
    await wrapper.find('.nav-close').trigger('click');
    expect(isOpen(wrapper)).toBe(false);
  });

  it('closes on a backdrop click', async () => {
    const wrapper = mountPreview();
    await wrapper.findAll('.row-detail')[1].trigger('click');
    await wrapper.find('.detail-backdrop').trigger('click');
    expect(isOpen(wrapper)).toBe(false);
  });

  it('closes on Escape, which is a window listener rather than an element handler', async () => {
    const wrapper = mountPreview();
    await wrapper.findAll('.row-detail')[1].trigger('click');
    globalThis.window.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();
    expect(isOpen(wrapper)).toBe(false);
  });

  it('ignores the arrow keys while closed rather than stepping the selection', async () => {
    const wrapper = mountPreview();
    const before = wrapper.find('.queue-item.current .row-who b').text();
    globalThis.window.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'ArrowRight' }));
    await flushPromises();
    expect(isOpen(wrapper)).toBe(false);
    expect(wrapper.find('.queue-item.current .row-who b').text()).toBe(before);
  });

  it('announces itself as a modal dialog once open', async () => {
    const wrapper = mountPreview();
    await wrapper.findAll('.row-detail')[0].trigger('click');
    const panel = wrapper.find('.entity-panel');
    expect(panel.attributes('role')).toBe('dialog');
    expect(panel.attributes('aria-modal')).toBe('true');
    expect(panel.attributes('aria-label')).toContain(shownDevice(wrapper));
  });

  it('gives every Detail button a label naming its device', async () => {
    const wrapper = mountPreview();
    const labels = wrapper.findAll('.row-detail').map(b => b.attributes('aria-label'));
    const names = wrapper.findAll('.queue-item').map(i => i.find('.row-who b').text());
    expect(labels).toEqual(names.map(n => `Show detail for ${n}`));
  });
});
