/**
 * The blocklist sinkhole fields. Mounting Blocklists.vue costs three stores
 * and the whole category table, so this pins the wiring by reading the
 * source, the way SubnetDetailGridInteractions does.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(TEST_DIR, '../../../src/views/Blocklists.vue'), 'utf8');

describe('Blocklists sinkhole settings', () => {
  it('edits both sinkhole addresses and shows the IPv6 one behind the switch', () => {
    expect(source).toContain('data-track="blocklist-redirect-ip"');
    expect(source).toMatch(
      /<div v-if="ipv6Supported" class="schedule-group">[\s\S]*?data-track="blocklist-redirect-ip6"/,
    );
    expect(source).toContain('blocklist_redirect_ip6: ip6,');
  });

  it('validates each address with the shared predicate for its family before saving', () => {
    expect(source).toMatch(/ip4 && !isValidIpv4\(ip4\)/);
    expect(source).toMatch(/ip6 && !isValidIpv6\(ip6\)/);
  });

  it('counts a changed sinkhole as a dirty form', () => {
    expect(source).toMatch(/redirectIp\.value\.trim\(\) !== savedRedirectIp\.value/);
    expect(source).toMatch(/redirectIp6\.value\.trim\(\) !== savedRedirectIp6\.value/);
  });
});
