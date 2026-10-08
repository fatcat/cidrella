import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() };
vi.mock('../../../src/api/client.js', () => ({ default: api }));
vi.mock('../../../src/ui/useToast.js', () => ({ useToast: () => ({ add: vi.fn() }) }));

const { default: Users } = await import('../../../src/views/Users.vue');

// The vendor widgets are stubbed to plain elements: the assertions are about
// what the page keeps in memory, not about the widgets.
const Dialog = {
  props: ['visible', 'header'],
  template:
    '<section v-if="visible" :data-header="header"><slot /><slot name="footer" /></section>',
};
const Button = {
  props: ['label'],
  emits: ['click'],
  template: '<button type="button" @click="$emit(\'click\', $event)">{{ label }}<slot /></button>',
};
const InputText = {
  props: ['modelValue', 'placeholder'],
  emits: ['update:modelValue'],
  template:
    '<input :value="modelValue" :placeholder="placeholder" @input="$emit(\'update:modelValue\', $event.target.value)" />',
};
const passthrough = { template: '<div><slot /></div>' };

function mountUsers() {
  return mount(Users, {
    global: {
      plugins: [createPinia()],
      stubs: {
        Dialog,
        Button,
        InputText,
        DataTable: passthrough,
        Column: passthrough,
        ContextMenu: passthrough,
        Toast: passthrough,
        Select: passthrough,
        EmptyState: passthrough,
      },
    },
  });
}

describe('one-time secrets in Users', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockImplementation((url) => {
      if (url === '/users/roles') return Promise.resolve({ data: [] });
      if (url === '/users') return Promise.resolve({ data: [] });
      if (url.endsWith('/tokens')) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
  });

  it('clears a revealed password when the dialog is dismissed', async () => {
    api.post.mockResolvedValue({ data: { id: 9, kind: 'human', password: 'On3-time-secret' } });
    const wrapper = mountUsers();
    await flushPromises();
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Add User')
      .trigger('click');
    const create = wrapper.find('[data-header="Create User"]');
    await create.find('input[placeholder="Enter username"]').setValue('ops');
    await create
      .findAll('button')
      .find((b) => b.text() === 'Create')
      .trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/users', expect.objectContaining({ username: 'ops' }));
    const reveal = wrapper.find('[data-header="User Password"]');
    expect(reveal.exists()).toBe(true);
    expect(reveal.find('input').element.value).toBe('On3-time-secret');
    await reveal
      .findAll('button')
      .find((b) => b.text() === 'Done')
      .trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-header="User Password"]').exists()).toBe(false);
    expect(wrapper.html()).not.toContain('On3-time-secret');
    // Reopening the reveal path with no new secret shows nothing stale.
    expect(wrapper.vm.$.setupState?.revealedPassword ?? '').toBe('');
  });

  it('clears a revealed token when its dialog is dismissed', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/users/roles') return Promise.resolve({ data: [] });
      if (url === '/users')
        return Promise.resolve({
          data: [{ id: 4, username: 'svc', kind: 'service', role: 'viewer', created_at: '' }],
        });
      if (url.endsWith('/tokens')) return Promise.resolve({ data: [] });
      return Promise.resolve({ data: [] });
    });
    api.post.mockResolvedValue({ data: { id: 1, token: 'cid_tok_ONE_TIME' } });
    const wrapper = mountUsers();
    await flushPromises();
    // Open the tokens dialog for the service account, then create a token.
    wrapper.vm.$.setupState.openTokensDialog({ id: 4, username: 'svc', kind: 'service' });
    await flushPromises();
    const tokens = wrapper.find('[data-header^="API Tokens"]');
    expect(tokens.exists()).toBe(true);
    wrapper.vm.$.setupState.tokenForm.name = 'ci';
    await wrapper.vm.$.setupState.createToken();
    await flushPromises();
    const reveal = wrapper.find('[data-header="API Token"]');
    expect(reveal.find('input').element.value).toBe('cid_tok_ONE_TIME');
    await reveal
      .findAll('button')
      .find((b) => b.text() === 'Done')
      .trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-header="API Token"]').exists()).toBe(false);
    expect(wrapper.html()).not.toContain('cid_tok_ONE_TIME');
    expect(wrapper.vm.$.setupState.revealedToken).toBe('');
  });
});
