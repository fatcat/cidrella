/**
 * The panel a replaced controller shows on Settings > Instances: what
 * happened, the report of changes the new controller never received, the
 * rejoin as a member (RejoinForm.vue, tested through the panel), and taking
 * the controller back. Against mocked API calls.
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
    props: ['label', 'disabled', 'loading', 'type', 'severity'],
    template:
      '<button :type="type || \'button\'" :disabled="disabled || loading" :data-severity="severity">{{ label }}</button>',
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
    props: ['visible', 'header', 'severity', 'confirmLabel', 'typeToConfirm'],
    emits: ['confirm', 'update:visible'],
    template:
      '<div v-if="visible" class="confirm" :data-severity="severity || \'danger\'" :data-typed="typeToConfirm"><h2>{{ header }}</h2><slot /><button type="button" class="go" @click="$emit(\'confirm\')">{{ confirmLabel }}</button></div>',
  },
}));

const FencedPanel = (await import('../../../../src/components/instances/FencedPanel.vue')).default;

const FENCED = { by_name: 'ns2', epoch: 4, since: '2026-11-21T11:00:00Z', report: true };
const show = (fenced = FENCED, selfName = 'ns1') =>
  mount(FencedPanel, { props: { fenced, selfName } });
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

  it('names the instance that reported it when that is not the new controller', () => {
    expect(
      show({ ...FENCED, told_by: 'ns3' })
        .find('.fenced-what')
        .text(),
    ).toMatch(/and its data is out of date\. ns3 reported it\.$/);
    expect(
      show({ ...FENCED, told_by: 'ns2' })
        .find('.fenced-what')
        .text(),
    ).not.toContain('reported it');
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

describe('Take the controller back', () => {
  const open = (w) => w.find('[data-track="instances-take-back"]').trigger('click');

  it('is offered below the rejoin, with when to use it', () => {
    const w = show();
    expect(w.text()).toContain('No other controller?');
    expect(w.text()).toContain(
      'If the instance that replaced this one is gone, this instance can take the controller back.',
    );
    const button = w.find('[data-track="instances-take-back"]');
    expect(button.text()).toBe('Take the controller back');
    expect(button.attributes('data-severity')).toBe('danger');
  });

  it('asks with a danger confirmation gated on this instance name, then promotes', async () => {
    api.post.mockResolvedValue({
      data: {
        restarting: true,
        dhcp: { active_instance_id: 'i-m3', name: 'ns3', reachable: true },
      },
    });
    const w = show();
    await open(w);
    const dialog = w.find('.confirm');
    expect(dialog.attributes('data-severity')).toBe('danger');
    expect(dialog.attributes('data-typed')).toBe('ns1');
    expect(dialog.find('h2').text()).toBe('Take the controller back?');
    expect(dialog.text()).toContain('Do this only when no other instance is the controller.');
    expect(dialog.text()).toMatch(
      /Changes made on ns2 since .+ are lost unless it comes back and you enter them again\./,
    );
    expect(dialog.text()).toContain(
      'The other members follow this instance within about a minute.',
    );
    expect(dialog.text()).toContain('This instance restarts, and you sign in again.');
    expect(dialog.find('.go').text()).toBe('Take the controller back');
    expect(api.post).not.toHaveBeenCalled();

    await dialog.find('.go').trigger('click');
    await flushPromises();
    expect(api.post).toHaveBeenCalledWith('/instances/promote-self', { confirm: true });
    expect(w.emitted('took-back')).toHaveLength(1);
    expect(w.find('.confirm').exists()).toBe(false);
    expect(toast.add).not.toHaveBeenCalled();
  });

  it('leaves out what is lost when it knows neither the controller nor the time', async () => {
    const w = show({ by_name: null, epoch: 4, since: null, report: false });
    await open(w);
    expect(w.find('.confirm').text()).not.toContain('are lost');
  });

  it('shows a refusal under the button, not as a toast, and stays put', async () => {
    const error = 'ns2 is the controller and answers. Rejoin it as a member.';
    api.post.mockRejectedValue({
      response: { status: 409, data: { error, code: 'controller_reachable' } },
    });
    const w = show();
    await open(w);
    await w.find('.confirm .go').trigger('click');
    await flushPromises();
    expect(w.find('[data-track="instances-take-back-error"]').text()).toBe(error);
    expect(toast.add).not.toHaveBeenCalled();
    expect(w.emitted('took-back')).toBeUndefined();
    expect(w.find('.confirm').exists()).toBe(false);

    // Asking again clears the old refusal.
    await open(w);
    expect(w.find('[data-track="instances-take-back-error"]').exists()).toBe(false);
  });
});

describe('the rejoin form without a header of its own', () => {
  it('names the address entered, and has no paragraph about changes made here', async () => {
    const RejoinForm = (await import('../../../../src/components/instances/RejoinForm.vue'))
      .default;
    api.post.mockResolvedValue({ data: { restarting: true } });
    const w = mount(RejoinForm);
    await fill(w, { address: ' ns3.example.net ' });
    await submit(w);
    const dialog = w.find('.confirm');
    expect(dialog.find('h2').text()).toBe('Join ns3.example.net as a member?');
    expect(dialog.text()).toContain(
      "The data on this instance is replaced by the new controller's",
    );
    expect(dialog.text()).not.toContain('never received');
    await dialog.find('.go').trigger('click');
    await flushPromises();
    expect(w.emitted('rejoined')).toEqual([[null]]);
  });
});
