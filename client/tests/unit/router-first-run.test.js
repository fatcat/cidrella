/**
 * Router precedence for a signed-in user: first-run setup wins over the
 * forced password change, a finished setup keeps /setup out of reach, and a
 * non-admin who still has to change their password goes where they always did.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { auth, features } = vi.hoisted(() => ({
  auth: {
    isAuthenticated: true,
    user: null,
    mustChangePassword: false,
    setupRequired: false,
    fetchUser: vi.fn(),
  },
  features: { loaded: true, load: vi.fn() },
}));
vi.mock('../../src/stores/auth.js', () => ({ useAuthStore: () => auth }));
vi.mock('../../src/stores/features.js', () => ({ useFeaturesStore: () => features }));
vi.mock('../../src/utils/landing.js', () => ({ rememberView: vi.fn() }));

const router = (await import('../../src/router/index.js')).default;

beforeEach(() => {
  auth.isAuthenticated = true;
  auth.user = { username: 'admin', role: 'admin' };
  auth.mustChangePassword = false;
  auth.setupRequired = false;
});

describe('first-run routing', () => {
  it('sends an admin with setup pending to the wizard from anywhere', async () => {
    auth.setupRequired = true;
    auth.mustChangePassword = true;
    await router.push('/networks');
    expect(router.currentRoute.value.name).toBe('FirstRun');
    await router.push('/change-password');
    expect(router.currentRoute.value.name).toBe('FirstRun');
  });

  it('keeps /setup out of reach once setup is done', async () => {
    // Leave the wizard route first: a push to the current route is a no-op
    // and would never run the guard.
    await router.push('/networks');
    await router.push('/setup');
    expect(router.currentRoute.value.name).not.toBe('FirstRun');
    expect(router.currentRoute.value.path).toBe('/analytics');
  });

  it('still forces the plain password change when setup is not the reason', async () => {
    auth.user = { username: 'ops', role: 'dns_admin' };
    auth.mustChangePassword = true;
    await router.push('/networks');
    expect(router.currentRoute.value.name).toBe('ChangePassword');
  });

  it('never sends a signed-out visitor to the wizard', async () => {
    auth.isAuthenticated = false;
    auth.setupRequired = true;
    await router.push('/setup');
    expect(router.currentRoute.value.name).toBe('Login');
  });
});
