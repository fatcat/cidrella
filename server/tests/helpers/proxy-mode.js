/**
 * For a test of the DNS proxy's own behavior: the proxy runs in the test's
 * process whatever CIDRELLA_DNS_PROXY says.
 *
 *   vi.mock('../../src/utils/dns-proxy-mode.js', async () =>
 *     (await import('../helpers/proxy-mode.js')).inlineProxyMode(),
 *   );
 */
export function inlineProxyMode() {
  return { PROXY_MODE: 'inline', proxyIsSeparate: () => false };
}
