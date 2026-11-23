/**
 * LogViewer: the stream it opens names the role and, for a member's log, the
 * instance; a member's log has no clear button; a member that stops
 * answering is said in the status line until it answers again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const { api } = vi.hoisted(() => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('../../../src/api/client.js', () => ({ default: api }));
vi.mock('../../../src/ui/Button.js', () => ({ default: { template: '<button />' } }));
vi.mock('../../../src/ui/InputText.js', () => ({ default: { template: '<input />' } }));

const LogViewer = (await import('../../../src/components/LogViewer.vue')).default;

const opened = [];
class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = {};
    opened.push(this);
  }
  addEventListener(name, fn) {
    this.listeners[name] = fn;
  }
  emit(name, data) {
    this.listeners[name]?.({ data });
  }
  close() {
    this.closed = true;
  }
}

beforeEach(() => {
  opened.length = 0;
  vi.stubGlobal('EventSource', FakeEventSource);
  api.post.mockResolvedValue({ data: { ticket: 'tk' } });
});
afterEach(() => vi.unstubAllGlobals());

const mountViewer = (props) =>
  mount(LogViewer, {
    props,
    global: {
      stubs: {
        StatusDot: {
          props: ['kind', 'label'],
          template: '<span class="dot" :data-kind="kind">{{ label }}</span>',
        },
      },
    },
  });

describe('LogViewer', () => {
  it("streams this box's log of a role, clearable", async () => {
    const w = mountViewer({ role: 'dhcp' });
    await flushPromises();
    expect(opened[0].url).toBe('/api/logs/stream?role=dhcp&ticket=tk');
    expect(w.find('[data-track="log-clear"]').exists()).toBe(true);
  });

  it("streams a member's log by its instance, never clearable here", async () => {
    const w = mountViewer({ role: 'dns', instance: 'm-1', clearable: true });
    await flushPromises();
    expect(opened[0].url).toBe('/api/logs/stream?role=dns&instance=m-1&ticket=tk');
    expect(w.find('[data-track="log-clear"]').exists()).toBe(false);
  });

  it('says when the member stops answering, and when it is back', async () => {
    const w = mountViewer({ role: 'dns', instance: 'm-1' });
    await flushPromises();
    const source = opened[0];
    source.emit('connected', 'ok');
    await flushPromises();
    expect(w.find('.dot').text()).toBe('Live');
    source.emit('watch-status', 'unreachable');
    await flushPromises();
    expect(w.find('.dot').text()).toBe('Instance not answering');
    expect(w.find('.dot').attributes('data-kind')).toBe('err');
    source.emit('watch-status', 'live');
    await flushPromises();
    expect(w.find('.dot').text()).toBe('Live');
    expect(w.find('.dot').attributes('data-kind')).toBe('ok');
  });
});
