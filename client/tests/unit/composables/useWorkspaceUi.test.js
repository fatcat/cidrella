import { beforeEach, describe, expect, it } from 'vitest';
import { CLASSIC_PATHS, useWorkspaceFontBump } from '../../../src/composables/useWorkspaceUi.js';

describe('workspace UI preferences', () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceFontBump().resize(-5);
  });

  it('clamps the small-text bump to 0..2 points and persists it', () => {
    const { fontBump, label, styleValue, resize, max } = useWorkspaceFontBump();
    expect(max).toBe(2);
    expect(fontBump.value).toBe(0);
    expect(label.value).toBe('Default');
    resize(1);
    expect(label.value).toBe('+1 pt');
    expect(styleValue.value).toBe('1.333px');
    resize(5);
    expect(fontBump.value).toBe(2);
    expect(localStorage.getItem('cidrella_workspace_font_bump')).toBe('2');
    resize(-1);
    expect(useWorkspaceFontBump().fontBump.value).toBe(1);
  });

  it('names the classic routes the user menu links to', () => {
    expect(CLASSIC_PATHS).toEqual({
      networks: '/networks-classic',
      settings: '/system-classic',
      anomalies: '/anomalies-classic',
    });
  });
});
