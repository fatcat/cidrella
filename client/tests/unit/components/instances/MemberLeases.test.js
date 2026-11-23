/**
 * The member's read-only lease list: leases and reservations from
 * GET /api/dhcp/leases worded for display, IPv4 and IPv6, a filter over what
 * is on screen, and an empty state. No actions.
 */
import { flushPromises, mount } from '@vue/test-utils';
import { reactive } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dhcp = reactive({ leases: [], fetchLeases: vi.fn() });
vi.mock('../../../../src/stores/dhcp.js', () => ({ useDhcpStore: () => dhcp }));
vi.mock('../../../../src/composables/useFeatures.js', async () => {
  const { ref } = await import('vue');
  return {
    useFeatures: () => ({ instance: ref({ mode: 'member', controller_name: 'ns1' }) }),
  };
});

const { default: MemberLeases } =
  await import('../../../../src/components/instances/MemberLeases.vue');

const LEASES = [
  {
    id: 1,
    dhcp_assignment_type: 'dynamic',
    ip_address: '192.0.2.50',
    mac_address: 'aa:bb:cc:dd:ee:01',
    hostname: 'laptop.lab.test',
    subnet_name: 'Lab',
    subnet_cidr: '192.0.2.0/24',
    subnet_domain_name: 'lab.test',
    lease_status: 'active',
    expires_at: '2026-11-23T18:00:00Z',
  },
  {
    id: 7,
    dhcp_assignment_type: 'reserved',
    ip_address: '2001:db8::20',
    mac_address: null,
    duid: '00:01:00:01:2a:2b:2c:2d:aa:bb:cc:dd:ee:02',
    hostname: null,
    subnet_name: null,
    subnet_cidr: '2001:db8::/64',
    lease_status: 'offline',
    expires_at: null,
  },
];

// The table stub lists each row's cells, or the empty slot.
const TableStub = {
  props: ['value', 'scrollHeight', 'loading'],
  template: `<div>
    <template v-if="value.length">
      <p v-for="row in value" :key="row.key" class="row">
        {{ [row.address, row.client, row.hostname, row.network, row.type, row.state, row.expires].join(' | ') }}
      </p>
    </template>
    <slot v-else name="empty" />
  </div>`,
};

function mountList() {
  return mount(MemberLeases, {
    global: {
      stubs: {
        DataTable: TableStub,
        Column: true,
        IconField: { template: '<div><slot /></div>' },
        InputIcon: true,
        InputText: {
          props: ['modelValue'],
          emits: ['update:modelValue'],
          template:
            '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
        },
        EmptyState: { props: ['title'], template: '<p class="empty">{{ title }}</p>' },
        StatusDot: true,
      },
    },
  });
}

const rows = (wrapper) => wrapper.findAll('.row').map((row) => row.text());

beforeEach(() => {
  vi.clearAllMocks();
  dhcp.leases = [];
  dhcp.fetchLeases.mockImplementation(async () => {
    dhcp.leases = LEASES;
  });
});

describe('member lease list', () => {
  it('reads the leases and words both families', async () => {
    const wrapper = mountList();
    await flushPromises();
    expect(dhcp.fetchLeases).toHaveBeenCalledOnce();
    const [v4, v6] = rows(wrapper);
    expect(v4).toMatch(
      /^192\.0\.2\.50 \| AA:BB:CC:DD:EE:01 \| laptop \| Lab \| Dynamic \| Active \| /,
    );
    expect(v6).toBe(
      '2001:db8::20 | 00:01:00:01:2a:2b:2c:2d:aa:bb:cc:dd:ee:02 | — | 2001:db8::/64 | Reserved | Inactive | Never',
    );
    expect(wrapper.text()).toContain('managed on ns1');
    expect(wrapper.find('button').exists()).toBe(false);
    wrapper.unmount();
  });

  it('filters on what is shown', async () => {
    const wrapper = mountList();
    await flushPromises();
    await wrapper.find('[data-track="member-leases-filter"]').setValue('2001:db8');
    expect(rows(wrapper)).toHaveLength(1);
    await wrapper.find('[data-track="member-leases-filter"]').setValue('aa:bb:cc:dd:ee:01');
    expect(rows(wrapper)[0]).toContain('192.0.2.50');
    await wrapper.find('[data-track="member-leases-filter"]').setValue('nothing here');
    expect(wrapper.find('.empty').text()).toBe('No leases match');
    wrapper.unmount();
  });

  it('says when there are none, and when they could not be read', async () => {
    dhcp.fetchLeases.mockResolvedValue([]);
    const empty = mountList();
    await flushPromises();
    expect(empty.find('.empty').text()).toBe('No leases');
    empty.unmount();

    dhcp.fetchLeases.mockRejectedValue({ response: { data: { error: 'boom' } } });
    const failed = mountList();
    await flushPromises();
    expect(failed.find('[data-track="member-leases-error"]').text()).toContain(
      'The leases could not be read',
    );
    failed.unmount();
  });
});
