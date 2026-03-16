import dns from 'dns';
import { DNS_TEST_TIMEOUT_MS, DNS_TEST_RETRY_DELAY_MS } from '../config/defaults.js';

/**
 * Test if a DNS forwarder is reachable by resolving google.com.
 * Retries once after a delay on failure.
 * @param {string} ip - DNS server IP to test
 * @returns {Promise<{reachable: boolean, addresses?: string[], error?: string}>}
 */
export async function testDnsForwarder(ip) {
  const resolver = new dns.Resolver();
  resolver.setServers([ip]);

  function tryResolve() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout')), DNS_TEST_TIMEOUT_MS);
      resolver.resolve4('google.com', (err, addresses) => {
        clearTimeout(timeout);
        if (err) reject(err);
        else resolve(addresses);
      });
    });
  }

  try {
    const addresses = await tryResolve();
    return { reachable: true, addresses };
  } catch {
    // Retry once after delay
    await new Promise(r => setTimeout(r, DNS_TEST_RETRY_DELAY_MS));
    try {
      const addresses = await tryResolve();
      return { reachable: true, addresses };
    } catch (err) {
      return { reachable: false, error: err.message || err.code };
    }
  }
}
