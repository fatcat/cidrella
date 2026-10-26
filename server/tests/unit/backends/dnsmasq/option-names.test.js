import { describe, it, expect } from 'vitest';
import {
  dnsmasqOption4Value,
  dnsmasqOptionToken,
  dnsmasqReadsAsText,
} from '../../../../src/backends/dnsmasq/option-names.js';

describe('dnsmasqOptionToken', () => {
  it('writes DHCPv4 options by number', () => {
    expect(dnsmasqOptionToken(42, 4)).toBe('42');
  });

  it('names a DHCPv6 option dnsmasq knows, and numbers the rest', () => {
    expect(dnsmasqOptionToken(23, 6)).toBe('option6:dns-server');
    expect(dnsmasqOptionToken(56, 6)).toBe('option6:ntp-server');
    // Captive Portal (103) has no dnsmasq name; the name would be refused.
    expect(dnsmasqOptionToken(103, 6)).toBe('option6:103');
    expect(dnsmasqOptionToken(200, 6)).toBe('option6:200');
  });
});

describe('dnsmasqReadsAsText', () => {
  it('follows dnsmasq: only what is no number, hex or address is text', () => {
    for (const v of ['600', '600i', '01:02', '1.2', '10.0.0.1,10.0.0.2', '10.0.0.0/8', '-5']) {
      expect(dnsmasqReadsAsText(v)).toBe(false);
    }
    for (const v of ['http://wpad/wpad.dat', 'abc', 'core', '/var/crash', 'a b', 'x-1']) {
      expect(dnsmasqReadsAsText(v)).toBe(true);
    }
  });
});

describe('dnsmasqOption4Value', () => {
  it('leaves an option dnsmasq types alone', () => {
    expect(dnsmasqOption4Value({ code: 26, type: 'number', width: 2 }, '1500')).toBe('1500');
    expect(dnsmasqOption4Value({ code: 66, type: 'text' }, '10.0.0.5')).toBe('10.0.0.5');
  });

  it('gives an untyped number its catalog width', () => {
    // Path MTU Aging Timeout is four bytes; dnsmasq alone would send 600 in two.
    expect(dnsmasqOption4Value({ code: 24, type: 'number', width: 4 }, '600')).toBe('600i');
    expect(dnsmasqOption4Value({ code: 29, type: 'select', width: 1 }, '1')).toBe('1b');
  });

  it('writes a list of numbers as bytes at the catalog width', () => {
    expect(
      dnsmasqOption4Value({ code: 25, type: 'text', list: true, width: 2 }, '68, 296,576'),
    ).toBe('00:44:01:28:02:40');
  });

  it('keeps a plain-string option a string', () => {
    const wpad = { code: 252, type: 'text' };
    expect(dnsmasqOption4Value(wpad, 'http://wpad/wpad.dat')).toBe('http://wpad/wpad.dat');
    expect(dnsmasqOption4Value(wpad, '1.2')).toBe('31:2e:32');
    expect(dnsmasqOption4Value({ code: 14, type: 'text' }, '600')).toBe('36:30:30');
    expect(dnsmasqOption4Value({ code: 60, type: 'text' }, '7')).toBe('55b');
  });

  it('leaves options written in dnsmasq value syntax as they are', () => {
    expect(dnsmasqOption4Value({ code: 43, type: 'text' }, '01:04:0a:00:00:01')).toBe(
      '01:04:0a:00:00:01',
    );
    expect(dnsmasqOption4Value({ code: 121, type: 'text' }, '10.0.0.0/8,10.1.0.1')).toBe(
      '10.0.0.0/8,10.1.0.1',
    );
  });

  it('treats a custom text option as a string and leaves a custom number to the width rule', () => {
    expect(dnsmasqOption4Value({ code: 200, type: 'text', custom: true }, '600')).toBe('36:30:30');
    expect(dnsmasqOption4Value({ code: 201, type: 'number', custom: true }, '600')).toBe('600');
  });
});
