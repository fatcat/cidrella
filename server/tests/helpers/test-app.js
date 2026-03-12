import express from 'express';

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

  app.use(prefix, router);
  return app;
}
