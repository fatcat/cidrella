import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadAs(platform, userAgentData) {
  vi.resetModules();
  vi.stubGlobal('navigator', { platform, userAgentData });
  return import('../../../src/utils/keyboard.js');
}

const key = (k, mods = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

afterEach(() => vi.unstubAllGlobals());

describe('keyboard shortcut modifier', () => {
  it('is Ctrl on Windows and Linux', async () => {
    for (const platform of ['Win32', 'Linux x86_64']) {
      const { MOD_LABEL, isModShortcut } = await loadAs(platform);
      expect(MOD_LABEL).toBe('Ctrl');
      expect(isModShortcut(key('k', { ctrlKey: true }), 'k')).toBe(true);
      expect(isModShortcut(key('K', { ctrlKey: true }), 'k')).toBe(true);
      expect(isModShortcut(key('k', { metaKey: true }), 'k')).toBe(false);
    }
  });

  it('is Command on a Mac', async () => {
    const { MOD_LABEL, isModShortcut } = await loadAs('MacIntel');
    expect(MOD_LABEL).toBe('⌘');
    expect(isModShortcut(key('k', { metaKey: true }), 'k')).toBe(true);
    expect(isModShortcut(key('k', { ctrlKey: true }), 'k')).toBe(false);
    // Chromium reports the platform through userAgentData first.
    expect((await loadAs('', { platform: 'macOS' })).MOD_LABEL).toBe('⌘');
    expect((await loadAs('MacIntel', { platform: 'Windows' })).MOD_LABEL).toBe('Ctrl');
  });

  it('ignores the key with extra modifiers or without the modifier', async () => {
    const { isModShortcut } = await loadAs('Win32');
    expect(isModShortcut(key('k'), 'k')).toBe(false);
    expect(isModShortcut(key('k', { ctrlKey: true, shiftKey: true }), 'k')).toBe(false);
    expect(isModShortcut(key('k', { ctrlKey: true, altKey: true }), 'k')).toBe(false);
    expect(isModShortcut(key('j', { ctrlKey: true }), 'k')).toBe(false);
  });
});
