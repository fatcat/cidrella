// Single declarative source for the Settings shell: drives the card-grid home,
// the area rail, and the per-area sub-tabs. Adding/moving an area is a config edit.
//
// Each sub-tab's `component` is a defineAsyncComponent factory (preserves the
// lazy-loading the old System.vue had). Optional per-sub-tab hatches:
//   keepAlive: true  — keep the panel mounted across sub-tab switches (form-heavy
//                      panels with unsaved edits); pair with onActivated refresh.
//   onEnter         — reserved for imperative load-on-enter (e.g. audit log).
//   badge           — () => string|number for a live count chip (reserved).
//
// NOTE: inline sections not yet extracted (SET-2) point at _Pending.vue and are
// swapped to their real component as each is extracted.

import { defineAsyncComponent } from 'vue';

const Pending = () => defineAsyncComponent(() => import('../views/settings/_Pending.vue'));

export const SETTINGS_AREAS = [
  {
    id: 'general', label: 'General', icon: 'pi pi-cog', group: 'Configuration',
    blurb: 'Naming, scanning, VLANs, interfaces', dataTrack: 'settings-area-general',
    subtabs: [
      { id: 'naming', label: 'Naming & Scanning', dataTrack: 'settings-sec-naming',
        component: defineAsyncComponent(() => import('../views/settings/NetworkSettings.vue')) },
      { id: 'vlans', label: 'VLANs', dataTrack: 'settings-sec-vlans',
        component: defineAsyncComponent(() => import('../views/settings/VlanSettings.vue')) },
      { id: 'interfaces', label: 'Interfaces', dataTrack: 'settings-sec-interfaces',
        component: defineAsyncComponent(() => import('../components/InterfacePanel.vue')) },
    ],
  },
  {
    id: 'dns', label: 'DNS', icon: 'pi pi-globe', group: 'Configuration',
    blurb: 'Forwarders, encryption, DNSSEC, SOA', dataTrack: 'settings-area-dns',
    subtabs: [
      { id: 'dns', label: 'DNS', dataTrack: 'settings-sec-dns',
        component: defineAsyncComponent(() => import('../views/DNS.vue')) },
    ],
  },
  {
    id: 'dhcp', label: 'DHCP', icon: 'pi pi-server', group: 'Configuration',
    blurb: 'Scopes, leases, rogue detection', dataTrack: 'settings-area-dhcp',
    subtabs: [
      { id: 'scopes', label: 'Scopes & Leases', dataTrack: 'settings-sec-dhcp',
        component: defineAsyncComponent(() => import('../views/DHCP.vue')) },
      { id: 'rogue', label: 'Rogue Detection', dataTrack: 'settings-sec-rogue-dhcp',
        component: defineAsyncComponent(() => import('../views/RogueDhcp.vue')) },
    ],
  },
  {
    id: 'filtering', label: 'Filtering', icon: 'pi pi-filter', group: 'Configuration',
    blurb: 'Categories, GeoIP, anomalies, whitelist', dataTrack: 'settings-area-filtering',
    subtabs: [
      { id: 'categories', label: 'Categories', dataTrack: 'settings-sec-blocklists',
        component: defineAsyncComponent(() => import('../views/Blocklists.vue')) },
      { id: 'geoip', label: 'GeoIP', dataTrack: 'settings-sec-geoip',
        component: defineAsyncComponent(() => import('../views/GeoIP.vue')) },
      { id: 'anomalies', label: 'Anomalies', dataTrack: 'settings-sec-anomaly',
        component: defineAsyncComponent(() => import('../views/AnomalyDetection.vue')) },
      { id: 'whitelist', label: 'Whitelist', dataTrack: 'settings-sec-whitelist',
        component: defineAsyncComponent(() => import('../views/settings/FilteringWhitelist.vue')) },
    ],
  },
  {
    id: 'access', label: 'Access', icon: 'pi pi-lock', group: 'System',
    blurb: 'Users & roles, TLS certificate', dataTrack: 'settings-area-access',
    subtabs: [
      { id: 'users', label: 'Users', dataTrack: 'settings-sec-users',
        component: defineAsyncComponent(() => import('../views/Users.vue')) },
      { id: 'certificate', label: 'TLS Certificate', dataTrack: 'settings-sec-certificates',
        component: defineAsyncComponent(() => import('../views/settings/CertificateSettings.vue')) },
    ],
  },
  {
    id: 'preferences', label: 'Preferences', icon: 'pi pi-palette', group: 'System',
    blurb: 'Appearance & theme', dataTrack: 'settings-area-preferences',
    subtabs: [
      { id: 'appearance', label: 'Appearance', dataTrack: 'settings-sec-themes',
        component: defineAsyncComponent(() => import('../views/settings/AppearanceSettings.vue')) },
    ],
  },
  {
    id: 'maintenance', label: 'Maintenance', icon: 'pi pi-wrench', group: 'System',
    blurb: 'Backup, updates, logs, import', dataTrack: 'settings-area-maintenance',
    subtabs: [
      { id: 'backup', label: 'Backup & Restore', dataTrack: 'settings-sec-backups',
        component: defineAsyncComponent(() => import('../views/settings/BackupSettings.vue')) },
      { id: 'updates', label: 'Updates', dataTrack: 'settings-sec-updates',
        component: defineAsyncComponent(() => import('../views/UpdatePanel.vue')) },
      { id: 'logs', label: 'Logs', dataTrack: 'settings-sec-logging',
        component: defineAsyncComponent(() => import('../views/settings/LogsSettings.vue')) },
      { id: 'import', label: 'Import', dataTrack: 'settings-sec-import',
        component: defineAsyncComponent(() => import('../components/PiholeImportPanel.vue')) },
    ],
  },
  {
    id: 'tools', label: 'Tools', icon: 'pi pi-calculator', group: 'Tools',
    blurb: 'Subnet calculator', dataTrack: 'settings-area-tools',
    subtabs: [
      { id: 'calculator', label: 'Subnet Calculator', dataTrack: 'settings-sec-calculator',
        component: defineAsyncComponent(() => import('../views/SubnetCalculator.vue')) },
    ],
  },
];

export const SETTINGS_GROUPS = ['Configuration', 'System', 'Tools'];

export function findArea(id) {
  return SETTINGS_AREAS.find(a => a.id === id) || null;
}
