/**
 * A member is sent away from the pages it does not show: a bookmark, a typed
 * address or the remembered last view after sign-in all land on Analytics
 * with the page named. A controller goes where it asked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { auth, features } = vi.hoisted(() => ({
  auth: {
    isAuthenticated: true,
    user: { username: 'admin', role: 'admin' },
    mustChangePassword: false,
    setupRequired: false,
    fetchUser: vi.fn(),
  },
  features: { loaded: true, load: vi.fn(), isMember: false },
}));
vi.mock('../../src/stores/auth.js', () => ({ useAuthStore: () => auth }));
vi.mock('../../src/stores/features.js', () => ({ useFeaturesStore: () => features }));
vi.mock('../../src/utils/landing.js', () => ({ rememberView: vi.fn() }));

const router = (await import('../../src/router/index.js')).default;
const where = () => ({
  path: router.currentRoute.value.path,
  query: { ...router.currentRoute.value.query },
});

beforeEach(async () => {
  features.isMember = false;
  await router.push('/change-password');
});

describe('routing on a member', () => {
  beforeEach(() => {
    features.isMember = true;
  });

  it.each([
    ['/networks', 'IP Management'],
    ['/networks-classic', 'IP Management'],
    // An old alias redirects first, then the guard sees where it leads.
    ['/subnets', 'IP Management'],
    ['/anomalies-classic', 'Anomalies'],
    ['/analytics?view=dashboard', 'Dashboard'],
    ['/anomalies-workspace', 'Anomalies'],
    ['/system?area=dns', 'DNS'],
    ['/dhcp', 'DHCP'],
    ['/system?area=general&sec=vlans', 'VLANs'],
    ['/system-classic?area=filtering', 'Filtering'],
  ])('sends %s to Analytics, naming %s', async (path, label) => {
    await router.push(path);
    expect(where()).toEqual({ path: '/analytics', query: { elsewhere: label } });
  });

  it.each([
    '/analytics?view=performance',
    '/system?area=general&sec=interfaces',
    '/system?area=instances&sec=leases',
    '/system?area=maintenance&sec=logs',
  ])('opens %s', async (path) => {
    await router.push(path);
    expect(router.currentRoute.value.fullPath).toBe(path);
  });
});

describe('routing on a controller', () => {
  it('opens IP Management and the DNS settings', async () => {
    await router.push('/networks');
    expect(where()).toEqual({ path: '/networks', query: {} });
    await router.push('/system?area=dns');
    expect(where()).toEqual({ path: '/system', query: { area: 'dns' } });
  });
});
