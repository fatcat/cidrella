/**
 * A 401 signs the browser out and tells the sign-in page why: the server's
 * SESSION_ENDED reason when it gives one. main.js registers the token and the
 * sign-out through configureApi; here they are stand-ins.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/stores/debug.js', () => ({
  useDebugStore: () => ({ logApi: () => {}, logError: () => {} }),
}));

const { default: api, configureApi } = await import('../../src/api/client.js');
const rejected = api.interceptors.response.handlers[0].rejected;
const sent = api.interceptors.request.handlers[0].fulfilled;

const auth = { token: 't' };
const onUnauthorized = vi.fn();
configureApi({ token: () => auth.token, onUnauthorized });

const failure = (url, status, data, token = 't') => ({
  config: { url, method: 'get', headers: { Authorization: `Bearer ${token}` } },
  response: { status, data },
});

beforeEach(() => {
  vi.clearAllMocks();
  auth.token = 't';
});

describe('API client on 401', () => {
  it("passes the server's reason on", async () => {
    await expect(
      rejected(failure('/networks', 401, { code: 'SESSION_ENDED', reason: 'idle' })),
    ).rejects.toBeTruthy();
    expect(onUnauthorized).toHaveBeenCalledWith('idle');
  });

  it('calls any other 401 a revoked session', async () => {
    await expect(
      rejected(failure('/networks', 401, { error: 'Invalid token' })),
    ).rejects.toBeTruthy();
    expect(onUnauthorized).toHaveBeenCalledWith('revoked');
  });

  it('ignores a 401 for a token this browser no longer holds', async () => {
    await expect(rejected(failure('/health', 401, {}, 'old'))).rejects.toBeTruthy();
    auth.token = null;
    await expect(rejected(failure('/health', 401, {}))).rejects.toBeTruthy();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('leaves a failed sign-in to the sign-in page', async () => {
    await expect(rejected(failure('/auth/login', 401, {}))).rejects.toBeTruthy();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe('API client on a request', () => {
  it('sends the registered token, and none when signed out', () => {
    expect(sent({ headers: {} }).headers.Authorization).toBe('Bearer t');
    auth.token = null;
    expect(sent({ headers: {} }).headers.Authorization).toBeUndefined();
  });
});
