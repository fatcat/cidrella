import { describe, it, expect } from 'vitest';
import { classify, normalizeOpt55 } from '../../../src/utils/device-classifier.js';

describe('normalizeOpt55', () => {
  it('strips spaces and option names, keeps codes', () => {
    expect(normalizeOpt55('1:netmask, 3:router, 6:dns-server, 15:domain-name')).toBe('1,3,6,15');
    expect(normalizeOpt55('1, 3 ,6,15')).toBe('1,3,6,15');
    expect(normalizeOpt55('')).toBe('');
    expect(normalizeOpt55(null)).toBe('');
  });
});

describe('classify', () => {
  it('identifies Windows from MSFT vendor class', () => {
    const r = classify({ opt60: 'MSFT 5.0' });
    expect(r.os_family).toBe('Windows');
    expect(r.device_type).toBe('Computer');
    expect(r.confidence).toBeGreaterThan(0);
  });

  it('identifies Android from vendor class', () => {
    expect(classify({ opt60: 'android-dhcp-13' }).os_family).toBe('Android');
  });

  it('identifies Apple iOS from hostname', () => {
    const r = classify({ hostname: 'Johns-iPhone' });
    expect(r.os_family).toBe('Apple iOS');
    expect(r.device_type).toBe('Smartphone');
  });

  it('identifies a printer from hostname', () => {
    expect(classify({ hostname: 'EPSON-WF-3720' }).device_type).toBe('Printer');
  });

  it('matches a Windows opt55 signature', () => {
    const r = classify({ opt55: '1,3,6,15,31,33,43,44,46,47,121,249,252' });
    expect(r.os_family).toBe('Windows');
  });

  it('matches an Android opt55 signature (with option names)', () => {
    const r = classify({ opt55: '1:netmask,3:router,6:dns-server,15:domain,26:mtu,28:broadcast,51:lease,58:t1,59:t2,43:vendor' });
    expect(r.os_family).toBe('Android');
  });

  it('boosts confidence when two signals agree on OS family', () => {
    const single = classify({ opt60: 'MSFT 5.0' });
    const agree = classify({ opt60: 'MSFT 5.0', hostname: 'DESKTOP-AB12CD' });
    expect(agree.confidence).toBeGreaterThan(single.confidence);
  });

  it('falls back to network/IoT/manufacturer device type from OUI vendor', () => {
    expect(classify({ vendor: 'Ubiquiti Inc' }).device_type).toBe('Network');
    expect(classify({ vendor: 'Espressif Inc.' }).device_type).toBe('IoT');
  });

  it('returns nulls + zero confidence for an unknown device', () => {
    const r = classify({ opt55: '99,98', hostname: 'thing', vendor: 'Nobody Co' });
    expect(r.os_family).toBeNull();
    expect(r.device_type).toBeNull();
    expect(r.confidence).toBe(0);
  });
});
