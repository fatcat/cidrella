import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startFakeKea } from '../../../helpers/fake-kea.js';
import { createKeaClient, KeaError } from '../../../../src/backends/kea/client.js';

let kea;
beforeAll(async () => {
  kea = await startFakeKea({ password: 'pw' });
});
afterAll(() => kea.close());

const client = (password = 'pw') =>
  createKeaClient({ port: kea.port, user: 'cidrella', password: () => password });

describe('createKeaClient', () => {
  it('sends the command with its arguments and unwraps the one-element reply', async () => {
    const reply = await client()('lease4-add', {
      'ip-address': '10.0.0.5',
      'hw-address': 'aa:bb:cc:00:00:01',
      'valid-lft': 60,
      expire: 2000000000,
    });
    expect(reply).toMatchObject({ result: 0, empty: false });
    expect(kea.calls.at(-1)).toMatchObject({ command: 'lease4-add' });
  });

  it('reports result 3 as empty, not an error', async () => {
    expect(await client()('lease4-del', { 'ip-address': '10.0.0.9' })).toMatchObject({
      result: 3,
      empty: true,
    });
  });

  it('throws a KeaError naming the command for a failure, bad credentials, or no answer', async () => {
    kea.fail('lease4-add', { result: 1, text: 'bad MAC' });
    await expect(client()('lease4-add', {})).rejects.toThrow(
      /lease4-add failed \(result 1\): bad MAC/,
    );
    await expect(client('wrong')('status-get')).rejects.toThrow(
      /credentials for status-get \(HTTP 401\)/,
    );
    const nobody = createKeaClient({
      port: 1,
      user: 'cidrella',
      password: () => 'pw',
      timeoutMs: 500,
    });
    await expect(nobody('status-get')).rejects.toBeInstanceOf(KeaError);
  });
});
