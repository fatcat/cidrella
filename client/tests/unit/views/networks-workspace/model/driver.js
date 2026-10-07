/* global document, KeyboardEvent, MouseEvent -- these run in the test DOM. */
// The things an operator can do to the Networks workspace, each a short
// label a failing walk prints and a regression test replays:
//
//   estate · unallocated · breadcrumb · reload · available · domain-names · hierarchy
//   folder <id|ungrouped> · toggle-folder <id|ungrouped>
//   network <id> [ctrl|shift] · tab <view> · stat <view>
//   zone <id> · pick-zone <id> · pick-network <id> · scope <id>
//   search "<text>" · table-search "<text>"
//   row <n> [ctrl|shift] · check <n> · check-all · row-menu <n> · close-details
//   filter <column> <n> · filter-text <column> "<text>" · clear-filter <column>
//   sort <column> · page next|prev · page-size <n>
//
// `candidates()` lists the ones the screen offers right now, so a random walk
// only does what a person could.
import { mountWorkspace, settle } from './harness.js';
import { NETWORKS, ZONES } from './fake-estate.js';

export const SEARCH_TERMS = ['', 'trust', 'lab', '10.0.1', 'laptop', '172.16', 'zzz'];
// Filter values are picked by their place in the menu's list; a pick past the
// end opens and closes the menu, as a person finding nothing there would.
const FILTER_PICKS = [0, 1];
const FILTER_TEXTS = {
  ip_address: '10.0.1',
  hostname: 'host-1',
  dns_hostname: 'home',
  record_name: 'host',
  value: '10.0.0.1',
  mac_address: '02:00',
};
const PAGE_SIZES = [32, 64, 256];

const all = (selector) => [...document.body.querySelectorAll(selector)];
const one = (selector) => document.body.querySelector(selector);

function click(element, modifier) {
  if (!element) throw new Error('nothing to click');
  const init = { bubbles: true, cancelable: true, button: 0 };
  if (modifier === 'ctrl') init.ctrlKey = true;
  if (modifier === 'shift') init.shiftKey = true;
  element.dispatchEvent(new MouseEvent('mousedown', init));
  element.dispatchEvent(new MouseEvent('click', init));
}
function type(input, text) {
  if (!input) throw new Error('no input');
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
const rowAt = (index) => all('tbody tr[data-row-id]')[index];

export function candidates() {
  const out = ['estate', 'unallocated', 'reload'];
  if (one('[data-track="workspace-breadcrumb-estate"]')) out.push('breadcrumb');
  for (const row of all('.folder-row[data-folder-id]')) {
    out.push(`folder ${row.dataset.folderId}`, `toggle-folder ${row.dataset.folderId}`);
  }
  for (const row of all('.network-row[data-network-id]:not([disabled])')) {
    const id = row.dataset.networkId;
    out.push(`network ${id}`, `network ${id} ctrl`, `network ${id} shift`);
  }
  for (const tab of all('.view-tabs button')) out.push(`tab ${tab.dataset.track.slice(14)}`);
  for (const stat of all('.health-stat.interactive'))
    out.push(`stat ${stat.dataset.track.slice('workspace-stat-'.length)}`);
  for (const card of all('.linked-card:not(.linked-picker)[data-zone-id]'))
    out.push(`zone ${card.dataset.zoneId}`);
  // The picker's list exists only while it is open: offer every reverse zone
  // and network, and let a pick of one it does not list be a look and close.
  if (one('.linked-picker')) {
    for (const zone of ZONES.filter((entry) => entry.type === 'reverse'))
      out.push(`pick-zone ${zone.id}`);
    for (const network of NETWORKS.filter((entry) => entry.status === 'allocated'))
      out.push(`pick-network ${network.id}`);
  }
  for (const card of all('.linked-card[data-scope-id]')) out.push(`scope ${card.dataset.scopeId}`);
  if (one('[data-track="workspace-global-search"]'))
    for (const term of SEARCH_TERMS) out.push(`search ${JSON.stringify(term)}`);
  if (one('.table-search input'))
    for (const term of SEARCH_TERMS) out.push(`table-search ${JSON.stringify(term)}`);
  const rows = all('tbody tr[data-row-id]').length;
  for (let index = 0; index < Math.min(rows, 6); index += 1) {
    out.push(`row ${index}`, `row ${index} ctrl`, `row ${index} shift`, `row-menu ${index}`);
    if (rowAt(index).querySelector('.check-cell input')) out.push(`check ${index}`);
  }
  if (one('thead .check-cell input')) out.push('check-all');
  if (one('.available-switch input')) out.push('available');
  if (one('.domain-names-switch input')) out.push('domain-names');
  if (one('[data-track="workspace-unallocated-hierarchy"]')) out.push('hierarchy');
  if (one('[aria-label="Close details"]')) out.push('close-details');
  // Filters and sorting on the columns the table shows.
  const columns = all('th[data-column]').map((header) => header.dataset.column);
  if (one('[data-track="workspace-filter-menu"]')) {
    for (const key of columns) {
      if (FILTER_TEXTS[key]) out.push(`filter-text ${key} ${JSON.stringify(FILTER_TEXTS[key])}`);
      else for (const pick of FILTER_PICKS) out.push(`filter ${key} ${pick}`);
    }
  }
  for (const chip of all('.filter-chips button[data-filter-key]'))
    out.push(`clear-filter ${chip.dataset.filterKey}`);
  for (const key of columns) out.push(`sort ${key}`);
  if (one('.paginator-stub [aria-label="Next Page"]:not([disabled])')) out.push('page next');
  if (one('.paginator-stub [aria-label="Previous Page"]:not([disabled])')) out.push('page prev');
  if (one('.paginator-stub select')) for (const size of PAGE_SIZES) out.push(`page-size ${size}`);
  return out;
}

// Runs one label against the mounted workspace. `session` holds the wrapper
// and remounts it for `reload`.
export async function perform(session, label) {
  const [verb, ...rest] = label.split(' ');
  const arg = rest[0];
  const modifier = rest[1] || (verb === 'row' ? rest[1] : undefined);
  switch (verb) {
    case 'estate':
      click(one('[data-track="workspace-estate-select"]'));
      break;
    case 'unallocated':
      click(one('[data-track="workspace-unallocated-select"]'));
      break;
    case 'breadcrumb':
      click(one('[data-track="workspace-breadcrumb-estate"]'));
      break;
    case 'folder':
      click(one(`.folder-row[data-folder-id="${arg}"] .folder-select`));
      break;
    case 'toggle-folder':
      click(one(`.folder-row[data-folder-id="${arg}"] .folder-toggle`));
      break;
    case 'network':
      click(one(`.network-row[data-network-id="${arg}"]`), modifier);
      break;
    case 'tab':
      click(one(`[data-track="workspace-tab-${arg}"]`));
      break;
    case 'stat':
      click(one(`[data-track="workspace-stat-${arg}"]`));
      break;
    case 'zone':
      click(one(`.linked-card:not(.linked-picker)[data-zone-id="${arg}"]`));
      break;
    case 'pick-zone':
    case 'pick-network': {
      click(one('.linked-picker'));
      await settle();
      const item =
        verb === 'pick-zone'
          ? one(`.picker-item[data-zone-id="${arg}"]`)
          : one(`.picker-heading[data-network-id="${arg}"]`);
      // Not listed: close the picker again.
      click(item || one('.linked-picker'));
      break;
    }
    case 'filter':
    case 'filter-text': {
      click(one('[data-track="workspace-filter-menu"]'));
      await settle();
      const column = one(`[data-track="workspace-filter-column-${arg}"]`);
      if (column) {
        click(column);
        await settle();
        if (verb === 'filter') {
          const value = all('.filter-value')[Number(rest[1])];
          if (value) click(value.querySelector('input'));
        } else {
          type(one('.filter-text input'), JSON.parse(rest.slice(1).join(' ')));
          await settle();
          one('.filter-text').dispatchEvent(
            new Event('submit', { bubbles: true, cancelable: true }),
          );
        }
        await settle();
      }
      // The menu stays open for more picks; close it as a person would.
      if (one('.filter-menu')) click(one('[data-track="workspace-filter-menu"]'));
      break;
    }
    case 'clear-filter':
      click(one(`.filter-chips button[data-filter-key="${arg}"]`));
      break;
    case 'sort':
      click(one(`th[data-column="${arg}"] button`));
      break;
    case 'page':
      click(one(`.paginator-stub [aria-label="${arg === 'next' ? 'Next' : 'Previous'} Page"]`));
      break;
    case 'page-size': {
      const select = one('.paginator-stub select');
      select.value = arg;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      break;
    }
    case 'scope':
      click(one(`.linked-card[data-scope-id="${arg}"]`));
      break;
    case 'search':
      type(one('[data-track="workspace-global-search"]'), JSON.parse(rest.join(' ')));
      break;
    case 'table-search':
      type(one('.table-search input'), JSON.parse(rest.join(' ')));
      break;
    case 'row':
      click(rowAt(Number(arg)), modifier);
      break;
    case 'check':
      click(rowAt(Number(arg)).querySelector('.check-cell input'));
      break;
    case 'check-all':
      click(one('thead .check-cell input'));
      break;
    case 'row-menu': {
      const row = rowAt(Number(arg));
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await settle();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      break;
    }
    case 'available':
      click(one('.available-switch input'));
      break;
    case 'domain-names':
      click(one('.domain-names-switch input'));
      break;
    case 'hierarchy':
      click(
        one('[data-track="workspace-unallocated-hierarchy"] input') ||
          one('[data-track="workspace-unallocated-hierarchy"]'),
      );
      break;
    case 'close-details':
      click(one('[aria-label="Close details"]'));
      break;
    case 'reload':
      session.wrapper.unmount();
      session.wrapper = mountWorkspace(session.pinia);
      break;
    default:
      throw new Error(`unknown action "${label}"`);
  }
  await settle();
}

// A small seeded generator, so a walk replays exactly from its seed.
export function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
