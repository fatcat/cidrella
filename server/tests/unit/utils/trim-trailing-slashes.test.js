import { describe, expect, it } from 'vitest';
import { trimTrailingSlashes } from '../../../src/utils/validation.js';

describe('trimTrailingSlashes', () => {
  it('drops every trailing slash and nothing else', () => {
    expect(trimTrailingSlashes('/api/auth/login/')).toBe('/api/auth/login');
    expect(trimTrailingSlashes('/api/auth/login///')).toBe('/api/auth/login');
    expect(trimTrailingSlashes('/api/auth/login')).toBe('/api/auth/login');
    expect(trimTrailingSlashes('http://pi.hole//admin/')).toBe('http://pi.hole//admin');
    expect(trimTrailingSlashes('///')).toBe('');
    expect(trimTrailingSlashes('')).toBe('');
  });

  it('stays linear on a long run of slashes', () => {
    // The regex it replaced took about 150 ms on this input.
    const path = '/api/' + '/'.repeat(16000) + 'x' + '/'.repeat(16000);
    const start = performance.now();
    for (let i = 0; i < 100; i++) trimTrailingSlashes(path);
    expect(trimTrailingSlashes(path).endsWith('x')).toBe(true);
    expect(performance.now() - start).toBeLessThan(100);
  });
});
