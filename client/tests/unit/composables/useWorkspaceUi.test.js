import { beforeEach, describe, expect, it } from 'vitest';
import {
  CLASSIC_NETWORKS_PATH,
  INTERFACE_PAIRS,
  useInterfacePreference,
  useWorkspaceFontBump,
} from '../../../src/composables/useWorkspaceUi.js';

describe('workspace UI preferences', () => {
  beforeEach(() => {
    localStorage.clear();
    useWorkspaceFontBump().resize(-5);
    useInterfacePreference().setPreference('current');
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

  it('maps navigation links and the open page to the preferred interface', () => {
    const { interfacePreference, setPreference, preferredPath, counterpart } =
      useInterfacePreference();
    // IP Management is cut over: the workspace is the route, the classic view
    // is a fallback path outside the preference.
    expect(INTERFACE_PAIRS.map(([current]) => current)).toEqual(['/system']);
    expect(CLASSIC_NETWORKS_PATH).toBe('/networks-classic');
    expect(preferredPath('/networks')).toBe('/networks');
    expect(counterpart('/networks')).toBeNull();
    expect(counterpart('/networks-classic')).toBeNull();

    setPreference('workspace');
    expect(interfacePreference.value).toBe('workspace');
    expect(localStorage.getItem('cidrella_interface')).toBe('"workspace"');
    expect(preferredPath('/networks')).toBe('/networks');
    expect(preferredPath('/system')).toBe('/system-preview');
    expect(preferredPath('/analytics')).toBe('/analytics');
    expect(counterpart('/system')).toBe('/system-preview');
    expect(counterpart('/system-preview')).toBeNull();
    expect(counterpart('/analytics')).toBeNull();

    setPreference('garbage');
    expect(interfacePreference.value).toBe('current');
  });
});
