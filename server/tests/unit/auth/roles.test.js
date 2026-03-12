import { describe, it, expect, vi } from 'vitest';
import { ROLES, hasPermission, requireRole } from '../../../src/auth/roles.js';

describe('ROLES', () => {
  it('defines admin with wildcard permission', () => {
    expect(ROLES.admin.permissions).toContain('*');
  });

  it('defines all expected roles', () => {
    const expected = ['admin', 'dns_admin', 'dhcp_admin', 'readonly_dns', 'readonly_dhcp', 'readonly'];
    expect(Object.keys(ROLES).sort()).toEqual(expected.sort());
  });
});

describe('hasPermission', () => {
  it('admin has all permissions', () => {
    expect(hasPermission('admin', 'subnets:read')).toBe(true);
    expect(hasPermission('admin', 'subnets:write')).toBe(true);
    expect(hasPermission('admin', 'dns:read')).toBe(true);
    expect(hasPermission('admin', 'dns:write')).toBe(true);
    expect(hasPermission('admin', 'dhcp:read')).toBe(true);
    expect(hasPermission('admin', 'dhcp:write')).toBe(true);
    expect(hasPermission('admin', 'anything:at:all')).toBe(true);
  });

  it('dns_admin can read/write DNS and read subnets', () => {
    expect(hasPermission('dns_admin', 'dns:read')).toBe(true);
    expect(hasPermission('dns_admin', 'dns:write')).toBe(true);
    expect(hasPermission('dns_admin', 'subnets:read')).toBe(true);
  });

  it('dns_admin cannot write subnets or touch DHCP', () => {
    expect(hasPermission('dns_admin', 'subnets:write')).toBe(false);
    expect(hasPermission('dns_admin', 'dhcp:read')).toBe(false);
    expect(hasPermission('dns_admin', 'dhcp:write')).toBe(false);
  });

  it('dhcp_admin can read/write DHCP and read subnets', () => {
    expect(hasPermission('dhcp_admin', 'dhcp:read')).toBe(true);
    expect(hasPermission('dhcp_admin', 'dhcp:write')).toBe(true);
    expect(hasPermission('dhcp_admin', 'subnets:read')).toBe(true);
  });

  it('dhcp_admin cannot write subnets or touch DNS', () => {
    expect(hasPermission('dhcp_admin', 'subnets:write')).toBe(false);
    expect(hasPermission('dhcp_admin', 'dns:read')).toBe(false);
    expect(hasPermission('dhcp_admin', 'dns:write')).toBe(false);
  });

  it('readonly_dns can only read DNS and subnets', () => {
    expect(hasPermission('readonly_dns', 'dns:read')).toBe(true);
    expect(hasPermission('readonly_dns', 'subnets:read')).toBe(true);
    expect(hasPermission('readonly_dns', 'dns:write')).toBe(false);
    expect(hasPermission('readonly_dns', 'dhcp:read')).toBe(false);
  });

  it('readonly_dhcp can only read DHCP and subnets', () => {
    expect(hasPermission('readonly_dhcp', 'dhcp:read')).toBe(true);
    expect(hasPermission('readonly_dhcp', 'subnets:read')).toBe(true);
    expect(hasPermission('readonly_dhcp', 'dhcp:write')).toBe(false);
    expect(hasPermission('readonly_dhcp', 'dns:read')).toBe(false);
  });

  it('readonly can read everything but write nothing', () => {
    expect(hasPermission('readonly', 'dns:read')).toBe(true);
    expect(hasPermission('readonly', 'dhcp:read')).toBe(true);
    expect(hasPermission('readonly', 'subnets:read')).toBe(true);
    expect(hasPermission('readonly', 'dns:write')).toBe(false);
    expect(hasPermission('readonly', 'dhcp:write')).toBe(false);
    expect(hasPermission('readonly', 'subnets:write')).toBe(false);
  });

  it('returns false for unknown role', () => {
    expect(hasPermission('nonexistent', 'dns:read')).toBe(false);
  });

  it('returns false for undefined role', () => {
    expect(hasPermission(undefined, 'dns:read')).toBe(false);
  });
});

describe('requireRole', () => {
  function mockReqRes(user) {
    const req = { user };
    const res = {
      _status: null,
      _body: null,
      status(code) { this._status = code; return this; },
      json(body) { this._body = body; return this; }
    };
    const next = vi.fn();
    return { req, res, next };
  }

  it('allows admin for any role requirement', () => {
    const middleware = requireRole('dns_admin');
    const { req, res, next } = mockReqRes({ id: 1, role: 'admin' });
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('allows matching role', () => {
    const middleware = requireRole('dns_admin', 'dhcp_admin');
    const { req, res, next } = mockReqRes({ id: 2, role: 'dns_admin' });
    middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('rejects non-matching role with 403', () => {
    const middleware = requireRole('dns_admin');
    const { req, res, next } = mockReqRes({ id: 3, role: 'readonly' });
    middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
  });

  it('rejects unauthenticated request with 401', () => {
    const middleware = requireRole('admin');
    const { req, res, next } = mockReqRes(undefined);
    middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(401);
  });
});
