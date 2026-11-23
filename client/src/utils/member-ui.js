// What a member shows. A member holds a read-only copy of its controller's
// data, so its UI keeps only what is about the box itself: its interfaces
// and servers, the Instances page, its own analytics, its logs, and its
// leases while it serves DHCP. Everything else is managed on the controller.
//
// This is presentation only. The server's write gate (sync/write-gate.js)
// stays the rule for what a member may change; hiding a page here just stops
// people trying.
//
// The settings sections a member shows are flagged in config/settingsAreas.js
// (`member`, `memberOnly`, `when`); every list of sections and areas comes
// from visibleSections and visibleAreas here, on a controller too.

import { ANALYTICS_SECTIONS } from '../config/analyticsSections.js';
import { SETTINGS_AREAS, findArea } from '../config/settingsAreas.js';

/** The Analytics sections a member shows: every row there is its own. */
export const MEMBER_ANALYTICS = ['performance', 'intelligence', 'map'];

/** Where Analytics opens: Performance on a member, which has no Dashboard. */
export const defaultAnalyticsView = (isMember) => (isMember ? 'performance' : 'dashboard');

/** The Analytics sections this box shows, in menu order. */
export function analyticsSections(isMember) {
  return isMember
    ? ANALYTICS_SECTIONS.filter((section) => MEMBER_ANALYTICS.includes(section.id))
    : ANALYTICS_SECTIONS;
}

// The header chips a member does not show: the network scanner and the
// anomaly sidecar run on the controller, and rogue DHCP servers are found
// and acknowledged there.
const MEMBER_HIDDEN_CHIPS = new Set(['scan', 'anomaly', 'rogue-dhcp']);

/** Whether the header shows a chip ('scan', 'anomaly', 'rogue-dhcp'). */
export const headerShows = (chip, isMember) => !isMember || !MEMBER_HIDDEN_CHIPS.has(chip);

// The switches as plain values, from useFeatures() (refs, or anything with a
// `value`) or a plain object.
const plain = (value) =>
  value !== null && typeof value === 'object' && 'value' in value ? value.value : value;
function plainFeatures(features) {
  return {
    ipv6: plain(features?.ipv6) === true,
    isMember: plain(features?.isMember) === true,
    instance: plain(features?.instance) || null,
  };
}

/** Whether a member lists a settings section, before its other conditions. */
const memberShows = (section) => section.member === true || section.memberOnly === true;

/**
 * The sections of a settings area this box lists: its feature switch on, the
 * member flags for what this box is, and its `when` condition.
 */
export function visibleSections(area, features) {
  const state = plainFeatures(features);
  return (area?.subtabs || []).filter(
    (section) =>
      (!section.feature || state[section.feature] === true) &&
      (state.isMember ? memberShows(section) : !section.memberOnly) &&
      (!section.when || section.when(state)),
  );
}

/** The settings areas with at least one section this box lists. */
export function visibleAreas(features) {
  return SETTINGS_AREAS.filter((area) => visibleSections(area, features).length > 0);
}

/**
 * The line under an area's name. A blurb names everything in the area, so a
 * member, which lists less, names the sections it lists instead.
 */
export function areaBlurb(area, features) {
  if (!plainFeatures(features).isMember) return area.blurb;
  return visibleSections(area, features)
    .map((section) => section.label)
    .join(', ');
}

/**
 * The visible areas the settings search matches: the area's label, its blurb
 * or the label of a section it lists. The blurb stays searchable on purpose,
 * it is where a word like "DNSSEC" is tied to the DNS area.
 */
export function matchingAreas(features, search) {
  const needle = (search || '').trim().toLowerCase();
  return visibleAreas(features).filter(
    (area) =>
      !needle ||
      area.label.toLowerCase().includes(needle) ||
      areaBlurb(area, features).toLowerCase().includes(needle) ||
      visibleSections(area, features).some((section) =>
        section.label.toLowerCase().includes(needle),
      ),
  );
}

const query = (route, key) => (typeof route?.query?.[key] === 'string' ? route.query[key] : '');

// The settings page a route opens, when a member does not show it: the area
// when none of its sections is a member's, else the section asked for when
// that one is not. A section hidden by a switch or a `when` condition is not
// managed elsewhere; the page falls back to the area's first section.
function settingsManagedElsewhere(route) {
  const area = findArea(query(route, 'area'));
  if (!area) return null;
  if (!area.subtabs.some(memberShows)) return area.label;
  const section = area.subtabs.find((entry) => entry.id === query(route, 'sec'));
  return section && !memberShows(section) ? section.label : null;
}

/**
 * The name of the page a route opens when a member does not show it, for
 * "<page> is managed on <controller>"; null when a member shows it. An
 * unknown Analytics view or settings area is the page's own fallback, so it
 * is not refused here.
 */
export function pageManagedElsewhere(route) {
  switch (route?.name) {
    case 'Networks':
    case 'NetworksClassic':
      return 'IP Management';
    case 'AnomaliesClassic':
      return 'Anomalies';
    case 'Analytics': {
      const section = ANALYTICS_SECTIONS.find((entry) => entry.id === query(route, 'view'));
      return section && !MEMBER_ANALYTICS.includes(section.id) ? section.label : null;
    }
    case 'System':
    case 'SystemClassic':
      return settingsManagedElsewhere(route);
    default:
      return null;
  }
}

/** Whether a member shows the page a route opens. */
export const allowedOnMember = (route) => pageManagedElsewhere(route) === null;

/**
 * Where the router sends a member that asked for a page it does not show:
 * Analytics, which names the page with a link to the controller.
 */
export const elsewhereRedirect = (label) => ({ path: '/analytics', query: { elsewhere: label } });
