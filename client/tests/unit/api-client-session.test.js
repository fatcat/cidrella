/**
 * A 401 signs the browser out and tells the sign-in page why: the server's
 * SESSION_ENDED reason when it gives one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { auth, router } = vi.hoisted(() => ({
  auth: { token: 't', logout: vi.fn() },
  router: { push: vi.fn() },
}));
vi.mock('../../src/stores/auth.js', () => ({ useAuthStore: () => auth }));
vi.mock('../../src/stores/debug.js', () => ({
  useDebugStore: () => ({ logApi: () => {}, logError: () => {} }),
}));
vi.mock('../../src/router/index.js', () => ({ default: router }));

const api = (await import('../../src/api/client.js')).default;
const rejected = api.interceptors.response.handlers[0].rejected;

const failure = (url, status, data, token = 't') => ({
  config: { url, method: 'get', headers: { Authorization: `Bearer ${token}` } },
  response: { status, data },
});

beforeEach(() => {
  vi.clearAllMocks();
  auth.token = 't';
});

describe('API client on 401', () => {
  it("passes the server's reason on and goes to sign-in", async () => {
    await expect(
      rejected(failure('/networks', 401, { code: 'SESSION_ENDED', reason: 'idle' })),
    ).rejects.toBeTruthy();
    expect(auth.logout).toHaveBeenCalledWith('idle');
    expect(router.push).toHaveBeenCalledWith('/login');
  });

  it('calls any other 401 a revoked session', async () => {
    await expect(rejected(failure('/networks', 401, { error: 'Invalid token' }))).rejects.toBeTruthy();
    expect(auth.logout).toHaveBeenCalledWith('revoked');
  });

  it('ignores a 401 for a token this browser no longer holds', async () => {
    await expect(rejected(failure('/health', 401, {}, 'old'))).rejects.toBeTruthy();
    auth.token = null;
    await expect(rejected(failure('/health', 401, {}))).rejects.toBeTruthy();
    expect(auth.logout).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('leaves a failed sign-in to the sign-in page', async () => {
    await expect(rejected(failure('/auth/login', 401, {}))).rejects.toBeTruthy();
    expect(auth.logout).not.toHaveBeenCalled();
  });
});
