import { describe, it, expect } from 'vitest';
import {
  formatInstanceStates,
  formatServiceStates,
  parseInstanceStates,
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

describe("every instance's states on the wire (the controller to a member)", () => {
  const C = 'a64cbcf0-80ad-49af-9441-8f67cb2a584e';
  const M = '4ac67048-d2d3-4cb8-bbd0-e32dc3ade765';

  it('round-trips each instance by its instance_id', () => {
    const states = {
      [C]: { dns: 'serving', dhcp: 'off' },
      [M]: { dns: 'down', dhcp: 'no_interface' },
    };
    const text = formatInstanceStates(states);
    expect(text).toBe(`${C}=dns:serving,dhcp:off;${M}=dns:down,dhcp:no_interface`);
    expect(parseInstanceStates(text)).toEqual(states);
  });

  it('drops what is not an instance_id or holds no usable state, and nothing is {}', () => {
    expect(
      parseInstanceStates(`${C}=dns:serving;nonsense=dns:off;${M}=dhcp:melting;=dns:on`),
    ).toEqual({
      [C]: { dns: 'serving' },
    });
    expect(parseInstanceStates('')).toEqual({});
    expect(parseInstanceStates(undefined)).toEqual({});
    expect(formatInstanceStates({ [C]: {} })).toBe('');
    expect(formatInstanceStates(null)).toBe('');
  });
});
