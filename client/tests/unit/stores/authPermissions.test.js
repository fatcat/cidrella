import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

const get = vi.fn();
const post = vi.fn();
vi.mock('../../../src/api/client.js', () => ({
  default: { get: (...args) => get(...args), post: (...args) => post(...args) },
}));

const { useAuthStore } = await import('../../../src/stores/auth.js');
const { usePermissions } = await import('../../../src/composables/usePermissions.js');

beforeEach(() => {
  setActivePinia(createPinia());
  localStorage.clear();
  get.mockReset();
  post.mockReset();
});

describe('server-projected permissions', () => {
  it('stores login capabilities and checks them without a client role table', async () => {
    post.mockResolvedValue({
      data: {
        token: 'jwt',
        user: {
          role: 'dns_admin',
          permissions: ['dns:read', 'dns:write', 'subnets:read'],
          is_admin: false,
        },
      },
    });

    const auth = useAuthStore();
    await auth.login('dns-user', 'secret');
    const access = usePermissions();

    expect(auth.permissions).toEqual(['dns:read', 'dns:write', 'subnets:read']);
    expect(auth.isAdmin).toBe(false);
    expect(access.can('dns:write')).toBe(true);
    expect(access.can('dhcp:read')).toBe(false);
    expect(access.canAny('dhcp:read', 'subnets:read')).toBe(true);
    expect(access.canAll(['dns:read', 'dns:write'])).toBe(true);
  });

  it('honors a server wildcard and admin flag without inferring either from role', async () => {
    get.mockResolvedValue({
      data: { role: 'custom-superuser', permissions: ['*'], is_admin: true },
    });
    const auth = useAuthStore();
    await auth.fetchUser();
    const access = usePermissions();

    expect(access.isAdmin.value).toBe(true);
    expect(access.can('future:permission')).toBe(true);
  });

  it('keeps older auth responses safe during a rolling upgrade', async () => {
    get.mockResolvedValue({ data: { role: 'readonly' } });
    const auth = useAuthStore();
    await auth.fetchUser();
    const access = usePermissions();

    expect(auth.permissions).toEqual([]);
    expect(auth.isAdmin).toBe(false);
    expect(access.can('subnets:read')).toBe(false);
  });
});
