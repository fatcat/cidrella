import express from 'express';
import { afterCommitMiddleware } from '../../src/utils/after-commit.js';
import { actorMiddleware } from '../../src/utils/request-actor.js';

/**
 * Create a minimal Express app for testing a router with supertest.
 * Injects a fake admin user so routes pass auth checks.
 */
export function createTestApp(
  router,
  prefix = '/api',
  user = { id: 1, role: 'admin', username: 'testadmin' },
) {
  const app = express();
  app.use(express.json());

  // Inject a fake authenticated user, an admin unless the test names another
  app.use((req, res, next) => {
    req.user = { ...user };
    next();
  });
  app.use(actorMiddleware);

  // Routes call req.afterCommit(hookName) to queue backend applies; the
  // middleware attaches that method. Tests stub the apply ops themselves
  // (stubBackendApply in helpers/fake-backends.js), but req.afterCommit
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
  app.use(actorMiddleware);
  app.use(afterCommitMiddleware);
  for (const { prefix, router } of mounts) {
    app.use(prefix, router);
  }
  return app;
}
