/**
 * Is this boot update.sh's preflight probe? It runs the new release against a
 * scratch data dir while the old release still serves. Its empty database says
 * nothing about the host, so nothing it decides may reach a host service.
 */
export const isPreflightBoot = () => process.env.CIDRELLA_PREFLIGHT === '1';
