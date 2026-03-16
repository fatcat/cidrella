// Role definitions and permission checks

export const ROLES = {
  admin: {
    label: 'Administrator',
    permissions: ['*']
  },
  dns_admin: {
    label: 'DNS Administrator',
    permissions: ['dns:read', 'dns:write', 'subnets:read', 'analytics:read']
  },
  dhcp_admin: {
    label: 'DHCP Administrator',
    permissions: ['dhcp:read', 'dhcp:write', 'subnets:read', 'analytics:read']
  },
  readonly_dns: {
    label: 'DNS Read-Only',
    permissions: ['dns:read', 'subnets:read', 'analytics:read']
  },
  readonly_dhcp: {
    label: 'DHCP Read-Only',
    permissions: ['dhcp:read', 'subnets:read', 'analytics:read']
  },
  readonly: {
    label: 'Read-Only',
    permissions: ['dns:read', 'dhcp:read', 'subnets:read', 'analytics:read']
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
