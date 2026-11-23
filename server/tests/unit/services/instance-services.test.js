import { describe, it, expect } from 'vitest';
import {
  formatServiceStates,
  parseServiceStates,
} from '../../../src/services/instance-services.js';

describe('service states on the wire', () => {
  it('round-trips both roles', () => {
    const states = { dns: 'serving', dhcp: 'off' };
    expect(formatServiceStates(states)).toBe('dns:serving,dhcp:off');
    expect(parseServiceStates(formatServiceStates(states))).toEqual(states);
  });

  it('drops a role or a state it does not know, and nothing usable is null', () => {
    expect(parseServiceStates('dns:down,ra:serving,dhcp:melting')).toEqual({ dns: 'down' });
    expect(parseServiceStates('')).toBeNull();
    expect(parseServiceStates('nonsense')).toBeNull();
    expect(parseServiceStates(undefined)).toBeNull();
    expect(parseServiceStates(['dns:serving'])).toBeNull();
    expect(formatServiceStates(null)).toBe('');
  });
});
