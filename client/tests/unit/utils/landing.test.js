/**
 * Where a sign-in lands you.
 *
 * Two of these are correctness, the rest are a security boundary. The
 * `redirect` query rides through the URL bar, so anyone can put anything in
 * it and hand the link to a user who will happily sign in and be forwarded.
 * "//evil.com" is the one that catches people out: it starts with a slash, so
 * a naive "is it relative" check passes it, and the browser then treats it as
 * protocol-relative and leaves the site.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRouter, createWebHistory } from 'vue-router';
import { landingPath, rememberView, safeInternalPath } from '../../../src/utils/landing.js';

const stub = { template: '<div />' };

function makeRouter() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/login', name: 'Login', component: stub },
      { path: '/change-password', name: 'ChangePassword', component: stub },
      { path: '/analytics', name: 'Analytics', component: stub },
      { path: '/networks-preview', name: 'NetworksWorkspacePreview', component: stub },
      { path: '/:pathMatch(.*)*', name: 'NotFound', component: stub },
    ],
  });
}

// Same routes with no catch-all. The real app has one, and it swallows every
// unmatched path into NotFound, which NON_LANDING then rejects. That masks the
// two guards below: with the catch-all present they never get to run, so a
// test using the full router passes whether or not they exist. These guards
// are the backstop for the day someone renames or drops that route, so they
// need a router that cannot stand in for them.
// A catch-all under any name other than NotFound. This is the regression the
// leading-slash guards exist for: the catch-all matches "//evil.example.com",
// so matched.length passes, and NON_LANDING has never heard of this route
// name, so it passes too. Nothing but the guards stands between that path and
// a redirect off the site.
function makeRouterWithRenamedCatchAll() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/analytics', name: 'Analytics', component: stub },
      { path: '/:pathMatch(.*)*', name: 'Fallback', component: stub },
    ],
  });
}

function makeRouterWithoutCatchAll() {
  return createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/login', name: 'Login', component: stub },
      { path: '/analytics', name: 'Analytics', component: stub },
    ],
  });
}

let router;
beforeEach(() => {
  localStorage.clear();
  router = makeRouter();
});

describe('safeInternalPath', () => {
  it('accepts an in-app path', () => {
    expect(safeInternalPath(router, '/networks-preview')).toBe('/networks-preview');
  });

  it('keeps the query string, which is where table state lives', () => {
    expect(safeInternalPath(router, '/analytics?tab=performance')).toBe('/analytics?tab=performance');
  });

  it('rejects a protocol-relative URL, which leaves the site despite the leading slash', () => {
    expect(safeInternalPath(router, '//evil.example.com')).toBeNull();
  });

  it('rejects the backslash variant browsers normalize into the same thing', () => {
    expect(safeInternalPath(router, '/\\evil.example.com')).toBeNull();
  });

  it('rejects an absolute URL', () => {
    expect(safeInternalPath(router, 'https://evil.example.com')).toBeNull();
  });

  it('rejects non-strings, including the array vue-router builds from a repeated query key', () => {
    expect(safeInternalPath(router, ['/analytics', '/login'])).toBeNull();
    expect(safeInternalPath(router, null)).toBeNull();
    expect(safeInternalPath(router, undefined)).toBeNull();
  });

  it('rejects the login form itself, which would be a redirect loop', () => {
    expect(safeInternalPath(router, '/login')).toBeNull();
  });

  it('rejects a path that matches nothing but the catch-all', () => {
    expect(safeInternalPath(router, '/removed-in-an-older-version')).toBeNull();
  });

  it('rejects a protocol-relative URL on its own, not because a catch-all caught it', () => {
    const bare = makeRouterWithoutCatchAll();
    expect(safeInternalPath(bare, '//evil.example.com')).toBeNull();
    expect(safeInternalPath(bare, '/\\evil.example.com')).toBeNull();
  });

  it('rejects a protocol-relative URL even when a catch-all would happily match it', () => {
    const renamed = makeRouterWithRenamedCatchAll();
    expect(safeInternalPath(renamed, '//evil.example.com')).toBeNull();
    expect(safeInternalPath(renamed, '/\\evil.example.com')).toBeNull();
    expect(safeInternalPath(renamed, 'https://evil.example.com')).toBeNull();
    // the same router still accepts a real route, so this is not a blanket no
    expect(safeInternalPath(renamed, '/analytics')).toBe('/analytics');
  });

  it('rejects an unknown path on its own, not because a catch-all caught it', () => {
    const bare = makeRouterWithoutCatchAll();
    expect(safeInternalPath(bare, '/no-such-route')).toBeNull();
    // and still accepts a real one, so the rejection is not blanket
    expect(safeInternalPath(bare, '/analytics')).toBe('/analytics');
  });
});

describe('landingPath', () => {
  it('prefers the page the user actually asked for', () => {
    rememberView('admin', { name: 'Analytics', fullPath: '/analytics', matched: [{}] });
    expect(landingPath(router, 'admin', '/networks-preview')).toBe('/networks-preview');
  });

  it('falls back to the last view when there is no redirect', () => {
    rememberView('admin', { name: 'NetworksWorkspacePreview', fullPath: '/networks-preview', matched: [{}] });
    expect(landingPath(router, 'admin', undefined)).toBe('/networks-preview');
  });

  it('ignores a last view belonging to a different user on this browser', () => {
    rememberView('admin', { name: 'NetworksWorkspacePreview', fullPath: '/networks-preview', matched: [{}] });
    expect(landingPath(router, 'someone-else', undefined)).toBe('/');
  });

  it('falls back to the default when a hostile redirect is supplied', () => {
    expect(landingPath(router, 'admin', '//evil.example.com')).toBe('/');
  });

  it('falls back to the default when the remembered route no longer exists', () => {
    localStorage.setItem('cidrella_last_view', JSON.stringify({ username: 'admin', path: '/subnets-old' }));
    expect(landingPath(router, 'admin', undefined)).toBe('/');
  });

  it('defaults when nothing is remembered', () => {
    expect(landingPath(router, 'admin', undefined)).toBe('/');
  });
});

describe('rememberView', () => {
  it('does not remember the login form or the password change step', () => {
    rememberView('admin', { name: 'Login', fullPath: '/login', matched: [{}] });
    rememberView('admin', { name: 'ChangePassword', fullPath: '/change-password', matched: [{}] });
    expect(localStorage.getItem('cidrella_last_view')).toBeNull();
  });

  it('does not remember a 404', () => {
    rememberView('admin', { name: 'NotFound', fullPath: '/nope', matched: [{}] });
    expect(localStorage.getItem('cidrella_last_view')).toBeNull();
  });

  it('does nothing without a username, so a logged-out navigation cannot overwrite', () => {
    rememberView(undefined, { name: 'Analytics', fullPath: '/analytics', matched: [{}] });
    expect(localStorage.getItem('cidrella_last_view')).toBeNull();
  });
});
