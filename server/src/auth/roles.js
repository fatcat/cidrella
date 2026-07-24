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

export function hasPermission(role, permission) {
  const roleDef = ROLES[role];
  if (!roleDef) return false;
  if (roleDef.permissions.includes('*')) return true;
  return roleDef.permissions.includes(permission);
}

export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!allowedRoles.includes(req.user.role) && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}
