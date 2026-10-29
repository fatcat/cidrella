/**
 * Where the DNS proxy runs: as its own process (`process`, dns-proxy/main.js,
 * the default) or inside the web app (`inline`), chosen by
 * CIDRELLA_DNS_PROXY at start.
 */
export const PROXY_MODE = process.env.CIDRELLA_DNS_PROXY === 'inline' ? 'inline' : 'process';
export const proxyIsSeparate = () => PROXY_MODE === 'process';
