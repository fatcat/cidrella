import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = {
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn()
};
const toast = { add: vi.fn() };
let statusPayload;

vi.mock('../../../src/api/client.js', () => ({ default: api }));
vi.mock('../../../src/ui/useToast.js', () => ({ useToast: () => toast }));

const { default: UpdatePanel } = await import('../../../src/views/UpdatePanel.vue');

describe('UpdatePanel lifecycle reconciliation report', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statusPayload = {
      state: 'failed',
      reason_code: 'ip_lifecycle_migration_blocked',
      error: 'Hosts printer.example.com and cups.example.com are A records for the same IP 192.0.2.20.',
      lifecycle_migration_report_available: true,
      lifecycle_migration_report_download: '/api/version/ip-lifecycle-migration-report'
    };
    api.get.mockImplementation((url) => {
      if (url === '/version') {
        return Promise.resolve({ data: {
          version: '0.4.17',
          updateAvailable: '0.4.18-pre.1',
          updateCheckEnabled: true,
          updateChain: []
        } });
      }
      if (url === '/version/update-status') {
        return Promise.resolve({ data: statusPayload });
      }
      if (url === '/version/ip-lifecycle-migration-report') {
        return Promise.resolve({ data: new Blob(['{}'], { type: 'application/json' }) });
      }
      return Promise.reject(new Error(`Unexpected GET ${url}`));
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:report');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });

  it('offers the administrator report and downloads it from the advertised endpoint', async () => {
    const wrapper = mount(UpdatePanel);
    await flushPromises();

    const button = wrapper.find('[data-track="update-download-lifecycle-report"]');
    expect(button.exists()).toBe(true);
    expect(wrapper.text()).toContain('Download the report, resolve every listed conflict');

    await button.trigger('click');
    await flushPromises();

    expect(api.get).toHaveBeenCalledWith(
      '/version/ip-lifecycle-migration-report',
      { responseType: 'blob' }
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:report');
    wrapper.unmount();
  });

  it('does not label an unrelated failure as a lifecycle conflict', async () => {
    statusPayload = {
      state: 'failed',
      reason_code: 'health_check_failed',
      error: 'The new service did not become healthy.',
      lifecycle_migration_report_available: true,
      lifecycle_migration_report_download: '/api/version/ip-lifecycle-migration-report'
    };

    const wrapper = mount(UpdatePanel);
    await flushPromises();

    expect(wrapper.find('[data-track="update-download-lifecycle-report"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('CIDRella found IP allocation conflicts');
    wrapper.unmount();
  });
});
