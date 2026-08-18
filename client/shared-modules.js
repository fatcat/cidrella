import { fileURLToPath, URL } from 'node:url';

/**
 * Where the client finds code shared with the server.
 *
 * The shared address core lives at server/src/utils/address.js rather than in a
 * top-level shared/ directory, on purpose. build-release.sh only rsyncs
 * server/, client/dist/, dnsmasq/, scripts/ and a few root files into the
 * tarball, and scripts/check-staging-imports.js already walks the staged server
 * tree checking that every relative import resolves. A module in server/ gets
 * both of those for free. A top-level shared/ would need new staging rules and
 * a new hole in that guard, which docs/CROSS-TIER-DUPLICATION.md warns is the
 * expensive part of this strategy and the part that only fails in a built
 * artifact.
 *
 * The client side needs no staging at all: Vite inlines this into the bundle
 * and only client/dist ships.
 *
 * Imported by both vite.config.js and vitest.config.js. Keep it that way. Two
 * copies of the alias is exactly the drift pair this whole effort is about.
 */
export const sharedAlias = {
  '@shared': fileURLToPath(new URL('../server/src/utils', import.meta.url))
};
