/**
 * Where the DNS proxy runs: inside the web app (`inline`, the default for
 * now) or as its own process (`process`, dns-proxy/main.js), chosen by
 * CIDRELLA_DNS_PROXY at start.
 */
export const PROXY_MODE = process.env.CIDRELLA_DNS_PROXY === 'process' ? 'process' : 'inline';
export const proxyIsSeparate = () => PROXY_MODE === 'process';
