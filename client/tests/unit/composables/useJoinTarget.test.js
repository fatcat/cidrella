/**
 * The controller a box joins: address, port and join token, validated once
 * for first run's Join step and for the rejoin of a replaced controller.
 */
import { describe, expect, it } from 'vitest';
import { useJoinTarget } from '../../../src/composables/useJoinTarget.js';

describe('useJoinTarget', () => {
  it('starts on port 443 and names what is missing, one thing at a time', () => {
    const { address, port, token, blocker } = useJoinTarget();
    expect(port.value).toBe(443);
    expect(blocker.value).toBe("Enter the controller's address.");
    address.value = '  ';
    expect(blocker.value).toBe("Enter the controller's address.");
    address.value = 'ns2.example.net';
    expect(blocker.value).toBe('Enter the join token.');
    token.value = 'abc';
    expect(blocker.value).toBe('');
    for (const bad of [null, 0, 65536, 44.5]) {
      port.value = bad;
      expect(blocker.value).toBe('Enter a port from 1 to 65535.');
    }
  });

  it('sends the values trimmed, either family', () => {
    const { address, port, token, body } = useJoinTarget();
    address.value = ' 2001:db8::2 ';
    port.value = 8443;
    token.value = ' tok-1 ';
    expect(body()).toEqual({ address: '2001:db8::2', port: 8443, token: 'tok-1' });
    address.value = '10.0.0.2';
    expect(body().address).toBe('10.0.0.2');
  });
});
