/**
 * The panel a replaced controller shows on Settings > Instances: what
 * happened, the report of changes the new controller never received, and the
 * rejoin as a member. Against mocked API calls.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';

const { api, toast, saveBlob } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn() },
  toast: { add: vi.fn() },
  saveBlob: vi.fn(),
}));
vi.mock('../../../../src/api/client.js', () => ({ default: api }));
vi.mock('../../../../src/ui/useToast.js', () => ({ useToast: () => toast }));
vi.mock('../../../../src/utils/download.js', () => ({ saveBlob }));
vi.mock('../../../../src/ui/Button.js', () => ({
  default: {
    props: ['label', 'disabled', 'loading', 'type'],
    template:
      '<button :type="type || \'button\'" :disabled="disabled || loading">{{ label }}</button>',
  },
}));
const input = (cast) => ({
  props: ['modelValue', 'disabled'],
  emits: ['update:modelValue'],
  setup: () => ({ cast }),
  template:
    '<input :value="modelValue" :disabled="disabled" @input="$emit(\'update:modelValue\', cast($event.target.value))" />',
});
vi.mock('../../../../src/ui/InputText.js', () => ({ default: input((v) => v) }));
vi.mock('../../../../src/ui/InputNumber.js', () => ({
  default: input((v) => (v === '' ? null : Number(v))),
}));
vi.mock('../../../../src/components/ConfirmDialog.vue', () => ({
  default: {
    props: ['visible', 'header', 'severity', 'confirmLabel'],
    emits: ['confirm', 'update:visible'],
    template:
      '<div v-if="visible" class="confirm" :data-severity="severity || \'danger\'"><h2>{{ header }}</h2><slot /><button type="button" class="go" @click="$emit(\'confirm\')">{{ confirmLabel }}</button></div>',
  },
}));

const FencedPanel = (await import('../../../../src/components/instances/FencedPanel.vue')).default;

const FENCED = { by_name: 'ns2', epoch: 4, since: '2026-11-21T11:00:00Z', report: true };
const show = (fenced = FENCED) => mount(FencedPanel, { props: { fenced } });
const field = (w, name) => w.find(`[data-track="instances-rejoin-${name}"]`);
async function fill(w, { address = 'ns2.example.net', port, token = 'tok-1' } = {}) {
  await field(w, 'address').setValue(address);
  if (port !== undefined) await field(w, 'port').setValue(port);
  await field(w, 'token').setValue(token);
}
const submit = (w) => w.find('form').trigger('submit');

beforeEach(() => vi.clearAllMocks());

describe('what happened', () => {
  it('says which instance replaced this one and since when, with an error mark', () => {
    const w = show();
    const what = w.find('.fenced-what');
    expect(what.text()).toMatch(
      /^ns2 replaced this instance as the controller\. This instance has taken no changes since .+, and its data is out of date\.$/,
    );
    expect(what.find('.cid-status-dot').classes()).toContain('sd-err');
    expect(w.text()).toContain('Make a join token on ns2 under Settings > System > Instances');
  });

  it('copes with a controller it cannot name', () => {
    const w = show({ by_name: null, epoch: 4, since: null, report: false });
    expect(w.find('.fenced-what').text()).toContain(
      'Another instance replaced this instance as the controller.',
    );
    expect(w.text()).toContain('Make a join token on the new controller under');
  });
});

describe('the report of changes not received', () => {
  it('is offered only when there is one, with what it is for', () => {
    const w = show();
    expect(w.find('[data-track="instances-divergence-report"]').text()).toBe(
      'Download report of changes not received',
    );
    expect(w.text()).toContain(
      'The report lists the changes made here that the new controller never received. Enter them again on the new controller by hand.',
    );
    const none = show({ ...FENCED, report: false });
    expect(none.find('[data-track="instances-divergence-report"]').exists()).toBe(false);
    expect(none.text()).not.toContain('The report lists');
  });

  it('downloads the JSON file', async () => {
    const blob = new Blob(['{}']);
    api.get.mockResolvedValue({ data: blob });
    const w = show();
    await w.find('[data-track="instances-divergence-report"]').trigger('click');
    await flushPromises();
    expect(api.get).toHaveBeenCalledWith('/instances/divergence-report', { responseType: 'blob' });
    expect(saveBlob).toHaveBeenCalledWith(blob, 'cidrella-changes-not-received.json');
  });

  it("shows the server's words when the download fails", async () => {
    api.get.mockRejectedValue({ response: { status: 404, data: { error: 'No report is kept.' } } });
    const w = show();
    await w.find('[data-track="instances-divergence-report"]').trigger('click');
    await flushPromises();
    expect(saveBlob).not.toHaveBeenCalled();
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'error',
        summary: 'Report not downloaded',
        detail: 'No report is kept.',
      }),
    );
  });
});

describe('Rejoin as a member', () => {
  it('names what is missing and will not ask until the form is whole', async () => {
    const w = show();
    const go = w.find('[data-track="instances-rejoin-submit"]');
    expect(field(w, 'port').element.value).toBe('443');
    expect(go.attributes('disabled')).toBeDefined();
    expect(w.find('.rejoin-actions').text()).toContain("Enter the controller's address.");
    await submit(w);
    expect(w.find('.confirm').exists()).toBe(false);

    await field(w, 'address').setValue('2001:db8::2');
    expect(w.find('.rejoin-actions').text()).toContain('Enter the join token.');
    await field(w, 'token').setValue('tok-1');
    await field(w, 'port').setValue('70000');
    expect(w.find('.rejoin-actions').text()).toContain('Enter a port from 1 to 65535.');
    await field(w, 'port').setValue('8443');
    expect(go.attributes('disabled')).toBeUndefined();
  });

  it('asks with a danger confirmation that says the data here is replaced, then rejoins', async () => {
    api.post.mockResolvedValue({ data: { controller: { name: 'ns2' }, restarting: true } });
    const w = show();
    await fill(w, { address: ' 10.0.0.7 ', token: ' tok-1 ' });
    await submit(w);
    const dialog = w.find('.confirm');
    expect(dialog.attributes('data-severity')).toBe('danger');
    expect(dialog.text()).toContain('Rejoin as a member of ns2?');
    expect(dialog.text()).toContain(
      "The data on this instance is replaced by the new controller's: networks, DNS, DHCP, settings and every account. A copy of the database as it is now is saved first.",
    );
    expect(dialog.text()).toContain('Download the report first if you need them.');
    expect(dialog.text()).toContain(
      'This instance restarts, and you sign in with an account from the new controller.',
    );
    expect(api.post).not.toHaveBeenCalled();

    await dialog.find('.go').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/instances/rejoin', {
      address: '10.0.0.7',
      port: 443,
      token: 'tok-1',
    });
    expect(w.emitted('rejoined')).toEqual([['ns2']]);
    expect(w.find('.confirm').exists()).toBe(false);
  });

  it.each([
    [400, 'token_invalid', 'The join token is not valid or has run out.'],
    [400, 'unreachable', 'ns2.example.net did not answer on port 443.'],
    [409, 'not_fenced', 'This instance was not replaced.'],
  ])('shows a %i %s refusal beside the form and stays put', async (status, code, error) => {
    api.post.mockRejectedValue({ response: { status, data: { error, code } } });
    const w = show();
    await fill(w);
    await submit(w);
    await w.find('.confirm .go').trigger('click');
    await flushPromises();
    expect(w.find('[data-track="instances-rejoin-error"]').text()).toBe(error);
    expect(w.emitted('rejoined')).toBeUndefined();
    expect(w.find('.confirm').exists()).toBe(false);
    expect(field(w, 'address').element.value).toBe('ns2.example.net');

    // Asking again clears the old refusal.
    await submit(w);
    expect(w.find('[data-track="instances-rejoin-error"]').exists()).toBe(false);
  });

  it('leaves the report out of the confirmation when there is none', async () => {
    const w = show({ ...FENCED, by_name: null, report: false });
    await fill(w);
    await submit(w);
    expect(w.find('.confirm').text()).toContain('Rejoin as a member?');
    expect(w.find('.confirm').text()).not.toContain('Download the report first');
  });
});
