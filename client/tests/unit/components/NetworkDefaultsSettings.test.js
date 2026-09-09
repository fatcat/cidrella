import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SETTINGS_AREAS } from '../../../src/config/settingsAreas.js';

const { getSettings, updateSetting, toastAdd } = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSetting: vi.fn(),
  toastAdd: vi.fn(),
}));

vi.mock('../../../src/stores/subnets.js', () => ({
  useSubnetStore: () => ({ getSettings, updateSetting })
}));
vi.mock('../../../src/ui/useToast.js', () => ({
  useToast: () => ({ add: toastAdd })
}));

const NetworkDefaultsSettings = (await import('../../../src/views/settings/NetworkDefaultsSettings.vue')).default;
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const dialogsSource = fs.readFileSync(
  path.resolve(TEST_DIR, '../../../src/components/NetworkDialogs.vue'),
  'utf8'
);

function mountSettings() {
  return mount(NetworkDefaultsSettings, {
    global: {
      stubs: {
        SelectButton: {
          props: ['modelValue', 'options'],
          emits: ['update:modelValue'],
          template: `<div class="gateway-options">
            <button v-for="option in options" :key="option.value" :class="option.value"
                    @click="$emit('update:modelValue', option.value)">{{ option.label }}</button>
          </div>`
        },
        Button: {
          props: ['label', 'disabled'],
          emits: ['click'],
          template: '<button class="save" :disabled="disabled" @click="$emit(\'click\')">{{ label }}</button>'
        }
      }
    }
  });
}

describe('Network Defaults settings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is a dedicated tab under General settings', () => {
    const general = SETTINGS_AREAS.find(area => area.id === 'general');
    expect(general.subtabs.map(tab => [tab.id, tab.label]))
      .toContainEqual(['network-defaults', 'Network Defaults']);
    expect(general.subtabs[0].id).toBe('naming');
  });

  it('loads and saves the retained gateway-position setting', async () => {
    getSettings.mockResolvedValueOnce({ default_gateway_position: 'last' });
    updateSetting.mockResolvedValueOnce({ key: 'default_gateway_position', value: 'first' });

    const wrapper = mountSettings();
    await flushPromises();

    expect(wrapper.text()).toContain('First allocatable IP');
    expect(wrapper.text()).toContain('Last allocatable IP');
    expect(wrapper.find('.save').attributes('disabled')).toBeDefined();

    await wrapper.find('.first').trigger('click');
    expect(wrapper.find('.save').attributes('disabled')).toBeUndefined();
    await wrapper.find('.save').trigger('click');
    await flushPromises();

    expect(updateSetting).toHaveBeenCalledWith('default_gateway_position', 'first');
  });

  it('wires the saved default into both new-network entry points', () => {
    expect(dialogsSource).toMatch(/async function openCreateNetwork[\s\S]*normalizeGatewayPositionDefault\(settings\.default_gateway_position\)/);
    expect(dialogsSource).toMatch(/async function openWizard\(\)[\s\S]*normalizeGatewayPositionDefault\(settings\.default_gateway_position\)/);
  });
});
