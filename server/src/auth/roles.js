// Role definitions and permission checks
//
// Scope vocabulary: dns:*, dhcp:*, subnets:* (IPAM), analytics:read, and
// system:* (host interfaces + app settings). system:read is granted to every
// role (settings/interfaces reads feed shared UI); system:write is held by
// admin only, via the wildcard, do not add it to other roles. Before
// v0.4.16 the system routes borrowed subnets:* scopes, which would have
// silently granted settings/interface writes to any future role given
// subnets:write for IPAM work.

export const ROLES = {
  admin: {
    label: 'Administrator',
    permissions: ['*']
  },
  dns_admin: {
    label: 'DNS Administrator',
    permissions: ['dns:read', 'dns:write', 'subnets:read', 'system:read', 'analytics:read']
  },
  dhcp_admin: {
    label: 'DHCP Administrator',
    permissions: ['dhcp:read', 'dhcp:write', 'subnets:read', 'system:read', 'analytics:read']
  },
  readonly_dns: {
    label: 'DNS Read-Only',
    permissions: ['dns:read', 'subnets:read', 'system:read', 'analytics:read']
  },
  readonly_dhcp: {
    label: 'DHCP Read-Only',
    permissions: ['dhcp:read', 'subnets:read', 'system:read', 'analytics:read']
  },
  readonly: {
    label: 'Read-Only',
    permissions: ['dns:read', 'dhcp:read', 'subnets:read', 'system:read', 'analytics:read']
  }
};

/**
 * Does this role hold the wildcard, ie. is it a superuser?
 *
 * The ROLES table is the only place that decides this. It used to be decided
 * twice: `hasPermission` read the '*' entry, and `requireRole` hardcoded
 * `role !== 'admin'`. They agree today only because admin is the sole wildcard
 * role. Add a second one and it would gain everything through requirePerm and
 * nothing through requireRole, which is a privilege split that no test would
 * have caught (duplicate-logic audit #27).
 */
export function isSuperuser(role) {
  const roleDef = ROLES[role];
  return Boolean(roleDef && roleDef.permissions.includes('*'));
}

export function hasPermission(role, permission) {
  const roleDef = ROLES[role];
  if (!roleDef) return false;
  if (isSuperuser(role)) return true;
  return roleDef.permissions.includes(permission);
}

/**
 * Role-based gate, kept alongside the permission-based `requirePerm`.
 *
 * NOT deleted, despite the audit suggesting it. All 11 remaining call sites are
 * `requireRole('admin')` guarding things with no permission name to migrate to:
 * bulk settings writes, user management, log clearing, audit reads, operations
 * and the updater. Expressing those through requirePerm means inventing
 * permissions and deciding which non-admin roles may hold them, which is a
 * change to the authorization model rather than a deduplication, and it belongs
 * in its own change with its own review. What IS shared now is the superuser
 * rule above, which was the actual divergence.
 */
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!allowedRoles.includes(req.user.role) && !isSuperuser(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}
