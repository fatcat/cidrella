/**
 * What a member shows (utils/member-ui.js), against the real settings
 * registry and Analytics sections: every route a member is refused and the
 * page name it gets, every settings section it lists, and the controller's
 * lists left as they were.
 */
import { describe, expect, it } from 'vitest';
import {
  MEMBER_ANALYTICS,
  allowedOnMember,
  areaBlurb,
  analyticsSections,
  defaultAnalyticsView,
  elsewhereRedirect,
  headerShows,
  matchingAreas,
  pageManagedElsewhere,
  visibleAreas,
  visibleSections,
} from '../../../src/utils/member-ui.js';
import { SETTINGS_AREAS, findArea } from '../../../src/config/settingsAreas.js';
import { ANALYTICS_SECTIONS } from '../../../src/config/analyticsSections.js';

const member = (serves_dhcp = false) => ({
  ipv6: false,
  isMember: true,
  instance: { mode: 'member', controller_name: 'ns1', serves_dhcp },
});
const controller = (ipv6 = false) => ({
  ipv6,
  isMember: false,
  instance: { mode: 'controller', serves_dhcp: true },
});

// What a member lists, area by area, in the registry's order.
function listing(features) {
  return Object.fromEntries(
    visibleAreas(features).map((area) => [
      area.id,
      visibleSections(area, features).map((section) => section.id),
    ]),
  );
}

describe('settings on a member', () => {
  it('lists only the sections about the box itself', () => {
    expect(listing(member())).toEqual({
      general: ['interfaces', 'servers'],
      access: ['certificate'],
      instances: ['instances'],
      preferences: ['appearance'],
      maintenance: ['backup', 'updates', 'logs'],
    });
  });

  it('lists the lease list only while the member serves DHCP', () => {
    expect(listing(member(true)).instances).toEqual(['instances', 'leases']);
  });

  it('reads switches given as refs, as useFeatures() gives them', () => {
    const asRefs = Object.fromEntries(
      Object.entries(member(true)).map(([key, value]) => [key, { value }]),
    );
    expect(listing(asRefs)).toEqual(listing(member(true)));
  });

  it('searches only what it lists', () => {
    expect(matchingAreas(member(), 'vlan')).toEqual([]);
    expect(matchingAreas(member(), 'logs').map((area) => area.id)).toEqual(['maintenance']);
    // A member's blurb names what it lists, not the whole area.
    expect(areaBlurb(findArea('general'), member())).toBe('Interfaces, Servers');
    expect(matchingAreas(member(), 'two-factor')).toEqual([]);
    expect(matchingAreas(controller(), 'two-factor').map((area) => area.id)).toEqual(['access']);
  });
});

describe('settings on a controller', () => {
  it('lists every area and every section but the member-only one', () => {
    const shown = listing(controller());
    expect(Object.keys(shown)).toEqual(SETTINGS_AREAS.map((area) => area.id));
    expect(shown.instances).toEqual(['instances']);
    expect(shown.dhcp).toEqual(['scopes', 'bulk', 'rogue']);
  });

  it('keeps a section gated on a switch behind it', () => {
    expect(listing(controller(true)).dhcp).toEqual(['scopes', 'scopes-v6', 'bulk', 'rogue']);
  });

  it('searches every area with no search text', () => {
    expect(matchingAreas(controller(), '  ')).toHaveLength(SETTINGS_AREAS.length);
  });
});

describe('analytics', () => {
  it('a member shows Performance, Intelligence and the Resolution Map, opening on Performance', () => {
    expect(analyticsSections(true).map((section) => section.id)).toEqual(MEMBER_ANALYTICS);
    expect(defaultAnalyticsView(true)).toBe('performance');
  });

  it('a controller shows every section and opens on the Dashboard', () => {
    expect(analyticsSections(false)).toBe(ANALYTICS_SECTIONS);
    expect(defaultAnalyticsView(false)).toBe('dashboard');
  });
});

describe('pages a member does not show', () => {
  const route = (name, query = {}) => ({ name, query });

  it.each([
    [route('Networks'), 'IP Management'],
    [route('NetworksClassic'), 'IP Management'],
    [route('AnomaliesClassic'), 'Anomalies'],
    [route('Analytics', { view: 'dashboard' }), 'Dashboard'],
    [route('Analytics', { view: 'anomalies' }), 'Anomalies'],
    [route('System', { area: 'dns' }), 'DNS'],
    [route('System', { area: 'dhcp', sec: 'rogue' }), 'DHCP'],
    [route('System', { area: 'filtering' }), 'Filtering'],
    [route('System', { area: 'tools' }), 'Tools'],
    [route('System', { area: 'general', sec: 'vlans' }), 'VLANs'],
    [route('System', { area: 'access', sec: 'users' }), 'Users'],
    [route('System', { area: 'maintenance', sec: 'import' }), 'Import'],
    [route('SystemClassic', { area: 'dns' }), 'DNS'],
  ])('%o is managed elsewhere as %s', (to, label) => {
    expect(pageManagedElsewhere(to)).toBe(label);
    expect(allowedOnMember(to)).toBe(false);
  });

  it.each([
    route('Analytics'),
    route('Analytics', { view: 'performance' }),
    route('Analytics', { view: 'intelligence' }),
    route('Analytics', { view: 'map' }),
    // An unknown view is the page's own fallback.
    route('Analytics', { view: 'nonsense' }),
    route('System'),
    route('System', { area: 'general' }),
    route('System', { area: 'general', sec: 'interfaces' }),
    route('System', { area: 'instances', sec: 'leases' }),
    route('System', { area: 'maintenance', sec: 'logs' }),
    route('System', { area: 'nowhere' }),
    // A section hidden by a switch falls back to the area's first one.
    route('System', { area: 'general', sec: 'nonsense' }),
    route('SystemClassic', { area: 'preferences' }),
    route('ChangePassword'),
    route('NotFound'),
  ])('%o is shown on a member', (to) => {
    expect(pageManagedElsewhere(to)).toBeNull();
    expect(allowedOnMember(to)).toBe(true);
  });

  it('every settings area a member cannot open names itself', () => {
    const hidden = SETTINGS_AREAS.filter((area) => !visibleAreas(member(true)).includes(area)).map(
      (area) => pageManagedElsewhere(route('System', { area: area.id })),
    );
    expect(hidden).toEqual(['DNS', 'DHCP', 'Filtering', 'Tools']);
    expect(findArea('tools')).not.toBeNull();
  });

  it('sends the member to Analytics with the page named', () => {
    expect(elsewhereRedirect('DNS')).toEqual({
      path: '/analytics',
      query: { elsewhere: 'DNS' },
    });
  });
});

describe('header chips', () => {
  it('a member hides the scanner, anomaly and rogue DHCP chips; a controller shows them', () => {
    for (const chip of ['scan', 'anomaly', 'rogue-dhcp']) {
      expect(headerShows(chip, true)).toBe(false);
      expect(headerShows(chip, false)).toBe(true);
    }
  });
});
