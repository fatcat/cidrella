import { nextTick } from 'vue';
import api from '../../../api/client.js';
import { apiError } from '../../../utils/format.js';
import { createWorkspaceActionRegistry, targetForRow } from '../workspace-actions.js';

// The handler side of the action registry (plan section 5, W-05). The
// orchestrator owns the state and the dialog refs; this composable owns what
// each action does with them. Every handler receives a frozen target built by
// targetForRow or by the orchestrator's context computeds, never a display
// label and never a live row reference.
export function useWorkspaceActions(ctx) {
  const {
    can,
    router,
    state,
    dialogs,
    selectNetwork,
    updateWorkspaceRoute,
    loadNetworkContext,
    refreshAggregateTable,
    showLiveNotice,
    openRangeEditor,
    openBulkRangeType,
    refreshAfterMutation,
    rememberDnsZoneSide,
  } = ctx;

  async function ensureNetworkDialogs() {
    if (!dialogs.networkDialogsMounted.value) {
      dialogs.networkDialogsMounted.value = true;
      await nextTick();
    }
    return dialogs.networkDialogs.value;
  }

  async function ensureProtocolDialogs() {
    if (!dialogs.protocolDialogsMounted.value) {
      dialogs.protocolDialogsMounted.value = true;
      await nextTick();
    }
    return { dns: dialogs.dnsDialogs.value, dhcp: dialogs.dhcpDialogs.value };
  }

  function networkNode(target) {
    return target?.raw?.id ? { key: `subnet-${target.raw.id}`, data: target.raw } : null;
  }

  function zoneFor(target) {
    if (target.kind === 'dns-zone') return target.raw;
    if (target.kind === 'workspace') return target.zone || null;
    if (target.kind === 'dns-record')
      return (
        state.dnsZones.value.find((zone) => Number(zone.id) === Number(target.zone_id)) || null
      );
    return null;
  }

  function scopeFor(target) {
    if (target.kind === 'dhcp-scope') return target.raw;
    if (target.kind === 'workspace') return target.scope || null;
    if (target.kind === 'range')
      return (
        state.dhcpScopes.value.find((scope) => Number(scope.range_id) === Number(target.id)) || null
      );
    const scopeId = target.scope_id ?? target.raw?.scope_id ?? target.raw?.dhcp_scope_id;
    return (
      state.dhcpScopes.value.find((scope) => Number(scope.id) === Number(scopeId)) ||
      state.selectedScopeFilter.value ||
      null
    );
  }

  async function drillIntoZone(zone, reload) {
    state.selectedZoneFilter.value = zone;
    rememberDnsZoneSide?.(zone);
    state.selectedScopeFilter.value = null;
    state.currentPage.value = 1;
    await updateWorkspaceRoute();
    await reload();
  }

  async function drillIntoScope(scope, reload) {
    state.selectedScopeFilter.value = scope;
    state.selectedZoneFilter.value = null;
    state.currentPage.value = 1;
    await updateWorkspaceRoute();
    await reload();
  }

  async function startNetworkScan(subnetId) {
    try {
      const { data } = await api.post('/scans', { subnet_id: subnetId });
      const id = data.id || data.scan_id;
      showLiveNotice(id ? `Network scan ${id} started.` : 'Network scan started.');
    } catch (error) {
      showLiveNotice(`Could not start network scan: ${apiError(error)}`);
    }
  }

  function openReservationEditor(target, mode) {
    dialogs.reservationTarget.value = { id: target.id, address: target.address };
    dialogs.reservationEditorMode.value = mode;
    dialogs.reservationEditorVisible.value = true;
  }

  // The per-address scan override, written the way AddressScanDialog writes it.
  async function setAddressScan(target, value, message) {
    const subnetId = state.selectedNetwork.value?.id;
    try {
      await api.put(`/subnets/${subnetId}/ips/${encodeURIComponent(target.address)}/scan-enabled`, {
        scan_enabled: value,
      });
      await refreshAfterMutation('address', `${target.address}: ${message}`);
    } catch (error) {
      showLiveNotice(`Could not change the scan setting for ${target.address}: ${apiError(error)}`);
    }
  }
  function openScanDialog(target, mode) {
    dialogs.scanTarget.value = { address: target.address, raw: { ...target.raw } };
    dialogs.scanDialogMode.value = mode;
    dialogs.scanDialogVisible.value = true;
  }

  const handlers = {
    // Read and navigation
    'network.open': (target) => selectNetwork(target.raw),
    'dns.zone.open': (target) => drillIntoZone(target.raw, refreshAggregateTable),
    'dhcp.scope.open': async (target) => {
      if (target.kind === 'dhcp-scope') return drillIntoScope(target.raw, refreshAggregateTable);
      const scope = scopeFor(target);
      if (!scope) return showLiveNotice('That scope is no longer in the inventory.');
      await drillIntoScope(scope, loadNetworkContext);
    },
    'network.open-dhcp': async (target) => {
      const network = state.allNetworks.value.find(
        (item) => Number(item.id) === Number(target.subnet_id),
      );
      if (!network) return showLiveNotice('That network is no longer in the inventory.');
      state.activeView.value = 'dhcp';
      await selectNetwork(network);
    },
    'dns.zones.switch-side': () => {
      state.filters.value = {
        ...state.filters.value,
        type: state.filters.value.type === 'forward' ? 'reverse' : 'forward',
      };
    },

    // Networks and folders
    'network.allocate': async (target) => {
      const dialogsRef = await ensureNetworkDialogs();
      // Browsing unallocated space with a leaf selected configures that leaf;
      // a folder target (its Actions menu or explorer row) creates a root in
      // that folder; anywhere else the current folder.
      const rowTarget = targetForRow(state.selectedRow.value);
      const node = rowTarget?.kind === 'network' ? networkNode(rowTarget) : null;
      if (node?.data?.status === 'unallocated') dialogsRef.openConfigure(node, node.data.folder_id);
      else if (target.kind === 'folder') await dialogsRef.openCreateNetwork(target.id ?? null);
      else await dialogsRef.openCreateNetwork(state.selectedFolder.value?.id || null);
    },
    'folder.create': async () => (await ensureNetworkDialogs()).openCreateFolder(),
    'folder.edit': async (target) => (await ensureNetworkDialogs()).openEditFolder(target.raw),
    'folder.delete': async (target) => (await ensureNetworkDialogs()).openDeleteFolder(target.raw),
    'folder.manage': () => {
      dialogs.folderManagerVisible.value = true;
    },
    'workspace.defaults': () =>
      router.push({ path: '/system', query: { area: 'general', sec: 'network-defaults' } }),
    'network.edit': async (target) => {
      const node = networkNode(target);
      (await ensureNetworkDialogs()).openEdit(node, node?.data?.folder_id);
    },
    'network.move': async (target) => {
      const node = networkNode(target);
      (await ensureNetworkDialogs()).openEdit(node, node?.data?.folder_id);
    },
    'network.scan': (target) => startNetworkScan(target.id),
    'network.divide': async (target) =>
      (await ensureNetworkDialogs()).openDivide(networkNode(target)),
    'network.merge': async (target) => (await ensureNetworkDialogs()).openMergeConfirm(target.ids),
    'network.apply-defaults': async (target) =>
      (await ensureNetworkDialogs()).executeApplyTemplate(
        target.kind === 'network-selection' ? target.ids : [target.id],
      ),
    'network.deallocate': async (target) =>
      (await ensureNetworkDialogs()).openDeallocate(networkNode(target)),
    'network.delete': async (target) =>
      (await ensureNetworkDialogs()).openDelete(networkNode(target)),
    // The gateway is edited on the network form; there is no separate gateway
    // resource to open.
    'network.gateway.edit': () => handlers['network.edit'](currentNetworkTarget()),
    'network.gateway.delete': () => handlers['network.edit'](currentNetworkTarget()),

    // DNS
    'dns.zone.create': async () => (await ensureProtocolDialogs()).dns.openZoneDialog(),
    'dns.zone.edit': async (target) =>
      (await ensureProtocolDialogs()).dns.openZoneDialog(zoneFor(target)),
    'dns.zone.delete': async (target) =>
      (await ensureProtocolDialogs()).dns.confirmDeleteZone(zoneFor(target)),
    'dns.record.create': async (target) =>
      (await ensureProtocolDialogs()).dns.openRecordEditor(null, {}, zoneFor(target)),
    'dns.record.create-cname': async (target) => {
      const zone = zoneFor(target);
      if (!zone) return showLiveNotice('That zone is no longer in the inventory.');
      (await ensureProtocolDialogs()).dns.openRecordEditor(null, { type: 'CNAME' }, zone);
    },
    'dns.record.edit': async (target) =>
      (await ensureProtocolDialogs()).dns.openRecordEditor(target.raw, {}, zoneFor(target)),
    'dns.record.delete': async (target) =>
      (await ensureProtocolDialogs()).dns.confirmDeleteRecordForZone(target.raw, zoneFor(target)),
    'dns.apply': async () => {
      try {
        await api.post('/dns/apply');
        await refreshAfterMutation('apply', 'DNS configuration applied for the whole appliance');
      } catch (error) {
        showLiveNotice(`Could not apply DNS configuration: ${apiError(error)}`);
      }
    },
    'dns.settings': () =>
      router.push({
        path: '/system',
        query: { area: 'dns', sec: 'dns', return: router.currentRoute.value.fullPath },
      }),

    // DHCP
    'dhcp.scope.create': async () => (await ensureProtocolDialogs()).dhcp.openScopeDialog(),
    'dhcp.scope.create-here': async () => (await ensureProtocolDialogs()).dhcp.openScopeDialog(),
    'dhcp.scope.edit': async (target) => {
      const scope = scopeFor(target);
      if (!scope) return showLiveNotice('That scope is no longer in the inventory.');
      await (await ensureProtocolDialogs()).dhcp.openScopeDialog(scope);
    },
    'dhcp.scope.delete': async (target) => {
      const scope = scopeFor(target);
      if (!scope) return showLiveNotice('That scope is no longer in the inventory.');
      (await ensureProtocolDialogs()).dhcp.confirmDeleteScope(scope);
    },
    'dhcp.scope.remove-members': () =>
      showLiveNotice(
        'Middle removal is not supported by the current pool API. Edit the DHCP scope to trim a start or end boundary.',
      ),
    'dhcp.leases.sync': async () => (await ensureProtocolDialogs()).dhcp.doSyncLeases(),
    'dhcp.reservation.create': async (target) => {
      const raw = target.raw || {};
      await (
        await ensureProtocolDialogs()
      ).dhcp.openReservationDialog(null, {
        subnet_id: state.selectedNetwork.value.id || raw.subnet_id || target.subnet_id || null,
        ip_address: target.address || raw.ip_address || '',
        mac_address: raw.mac_address || '',
        hostname: target.hostname || raw.hostname || '',
      });
    },
    'dhcp.reservation.edit': async (target) =>
      (await ensureProtocolDialogs()).dhcp.openReservationDialog(target.raw),
    'dhcp.reservation.delete': async (target) =>
      (await ensureProtocolDialogs()).dhcp.confirmDeleteReservation(target.raw),
    'dhcp.apply': async () => {
      try {
        await api.post('/dhcp/apply');
        await refreshAfterMutation('apply', 'DHCP configuration applied for the whole appliance');
      } catch (error) {
        showLiveNotice(`Could not apply DHCP configuration: ${apiError(error)}`);
      }
    },
    'dhcp.settings': () =>
      router.push({
        path: '/system',
        query: { area: 'dhcp', sec: 'scopes', return: router.currentRoute.value.fullPath },
      }),

    // Addresses
    'ip.reserve': (target) => openReservationEditor(target, 'reserve'),
    'ip.release': (target) => openReservationEditor(target, 'release'),
    'ip.reserve-new': () => openReservationEditor({ address: '' }, 'reserve'),
    'ip.bulk-reserve': () => {
      dialogs.bulkActionMode.value = 'reserve';
      dialogs.bulkActionVisible.value = true;
    },
    'ip.bulk-release': () => {
      dialogs.bulkActionMode.value = 'release';
      dialogs.bulkActionVisible.value = true;
    },
    'ip.bulk-range-type': () => openBulkRangeType(),
    'ip.range-type': async (target) => {
      state.selectedRows.value = [target.id];
      await openBulkRangeType();
    },
    'ip.scan-toggle': (target) => {
      const raw = target.raw || {};
      const enabled = raw.scanning_enabled === true || raw.scanning_enabled === 1;
      return setAddressScan(
        target,
        !enabled,
        enabled ? 'liveness scan disabled' : 'liveness scan enabled',
      );
    },
    'ip.scan-inherit': (target) => setAddressScan(target, null, 'scan setting reset to inherit'),
    'ip.probe': (target) => openScanDialog(target, 'probe'),

    // Ranges
    'range.create': () => openRangeEditor(null),
    'range.edit': (target) => openRangeEditor(target.raw),
    'range.delete': (target) => openRangeEditor(target.raw),
  };

  // The selected network is only a target while the workspace is in network
  // context. Outside it the ref still holds the last or first network as a
  // default, and offering "Delete network" against that from All Networks was
  // a bug in the label-matched dispatch.
  function currentNetworkTarget() {
    const network = state.selectedNetwork.value;
    if (state.contextKind.value !== 'network' || !network?.id) return null;
    return { kind: 'network', id: network.id, status: network.status, raw: network };
  }

  const registry = createWorkspaceActionRegistry({ can, handlers });

  // Runs an action for a target, surfacing the registry's reason when it
  // refuses. Menus only offer available actions, so a refusal here means the
  // target changed under the menu (a row was deleted, a permission was
  // revoked) rather than a UI mistake.
  async function invoke(actionId, target) {
    const outcome = await registry.invoke(actionId, target);
    if (!outcome.invoked) showLiveNotice(outcome.reason);
    return outcome;
  }

  return { registry, invoke, startNetworkScan, currentNetworkTarget };
}
