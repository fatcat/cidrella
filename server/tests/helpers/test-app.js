import express from 'express';
import { afterCommitMiddleware } from '../../src/utils/after-commit.js';

/**
 * Create a minimal Express app for testing a router with supertest.
 * Injects a fake admin user so routes pass auth checks.
 */
export function createTestApp(router, prefix = '/api') {
  const app = express();
  app.use(express.json());

  // Inject fake authenticated admin user
  app.use((req, res, next) => {
    req.user = { id: 1, role: 'admin', username: 'testadmin' };
    next();
  });

  // Routes call req.afterCommit(hookName) to queue dnsmasq regens; the
  // middleware attaches that method. In tests the hook bodies are mocked
  // to no-ops via vi.mock on the dnsmasq/dhcp utils, but req.afterCommit
  // itself must exist so the route handlers don't throw.
  app.use(afterCommitMiddleware);

  app.use(prefix, router);
  return app;
}

/**
 * Create a test app with multiple routers mounted at different prefixes.
 * For cross-resource tests that need to exercise, e.g., subnets + dns + dhcp
 * simultaneously (divide preserves DNS zones, merge preserves DHCP scopes).
 *
 * `mounts` is an array of { prefix, router } entries applied in order.
 */
export function createMultiRouterApp(mounts) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: 1, role: 'admin', username: 'testadmin' };
    next();
  });
  app.use(afterCommitMiddleware);
  for (const { prefix, router } of mounts) {
    app.use(prefix, router);
  }
  return app;
}
