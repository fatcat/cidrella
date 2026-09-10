import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const get = vi.fn();
const post = vi.fn();
vi.mock('../../../src/api/client.js', () => ({
  default: { get: (...args) => get(...args), post: (...args) => post(...args) }
}));

const { useSubnetStore } = await import('../../../src/stores/subnets.js');

beforeEach(() => {
  setActivePinia(createPinia());
  get.mockReset();
  post.mockReset();
  get.mockResolvedValue({ data: { folders: [] } });
});

describe('subnet transformation client boundary', () => {
  it('does not present a fully subdivided container as unallocated space', () => {
    const store = useSubnetStore();
    store.folders = [{
      id: 1,
      name: 'Lab',
      subnets: [{
        id: 10,
        cidr: '1.1.1.0/24',
        network_address: '1.1.1.0',
        prefix_length: 24,
        status: 'unallocated',
        children: [
          { id: 11, cidr: '1.1.1.0/25', network_address: '1.1.1.0', prefix_length: 25, status: 'allocated' },
          { id: 12, cidr: '1.1.1.128/25', network_address: '1.1.1.128', prefix_length: 25, status: 'allocated' }
        ]
      }]
    }];

    expect(store.unallocatedTreeNodes).toEqual([]);
    expect(store.allocatedTreeNodes[0].children.map(node => node.data.cidr))
      .toEqual(['1.1.1.0/25', '1.1.1.128/25']);
  });

  it('executes the exact server preview and carries reviewed record identities', async () => {
    const plan = { dependency_token: 'dependency', plan_id: 'plan' };
    post
      .mockResolvedValueOnce({ data: { plan } })
      .mockResolvedValueOnce({ data: { children: [] } });
    const store = useSubnetStore();
    const resolutions = [{ carries: 'dhcp_lease', record_id: 41, action: 'delete' }];

    await store.divideSubnet(7, {
      new_prefix: 26,
      force: true,
      conflict_resolutions: resolutions,
      target_gateways: [{ cidr: '10.0.0.0/26', policy: 'last' }]
    });

    expect(post).toHaveBeenNthCalledWith(1, '/subnets/7/divide/preview', {
      new_prefix: 26,
      target_gateways: [{ cidr: '10.0.0.0/26', policy: 'last' }]
    });
    expect(post).toHaveBeenNthCalledWith(2, '/subnets/7/divide', {
      force: true,
      new_prefix: 26,
      target_gateways: [{ cidr: '10.0.0.0/26', policy: 'last' }],
      conflict_resolutions: resolutions,
      plan_token: 'dependency',
      plan_id: 'plan'
    });
  });

  it('passes merge preview tokens to execution unchanged', async () => {
    post.mockResolvedValue({ data: { id: 9 } });
    const store = useSubnetStore();
    await store.mergeSubnets([3, 2], 'dependency', 'plan');
    expect(post).toHaveBeenCalledWith('/subnets/merge', {
      subnet_ids: [3, 2], plan_token: 'dependency', plan_id: 'plan'
    });
  });
});
