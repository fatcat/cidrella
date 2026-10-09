import { describe, it, expect } from 'vitest';
import {
  cellMiddle,
  createCityTableBuilder,
  encodeCityTable,
  decodeCityTable,
  cityPlaceIn,
  CELL_KM,
} from '../../../src/utils/geo-cities.js';

const BERLIN = [52.52, 13.405];
const MUNICH = [48.137, 11.575];
const PARIS = [48.857, 2.352];

function build(rows) {
  const builder = createCityTableBuilder();
  for (const [start, end, cc, [lat, lon]] of rows) builder.add(start, end, cc, lat, lon);
  return decodeCityTable(encodeCityTable(builder.finish(), { month: '2026-10' }));
}

const placeOf = (table, ip) => {
  const p = cityPlaceIn(table, ip);
  return p && [p.country, p.lat, p.lon];
};
// What the table stores for a point: its cell's middle, in hundredths.
const cell = (country, [lat, lon]) => [
  country,
  ...cellMiddle(lat, lon).map((v) => Math.round(v * 100) / 100),
];

describe('cellMiddle', () => {
  it('snaps nearby points together and keeps far ones apart', () => {
    const a = cellMiddle(52.52, 13.405);
    expect(cellMiddle(52.53, 13.41)).toEqual(a);
    expect(cellMiddle(...MUNICH)).not.toEqual(a);
  });

  it('stays within about one cell of the point, near the equator and the poles', () => {
    for (const [lat, lon] of [
      [0.1, 0.1],
      [-33.87, 151.21],
      [69.65, 18.96],
      [-89.9, 179.9],
    ]) {
      const [mLat, mLon] = cellMiddle(lat, lon);
      const km = Math.hypot(
        (mLat - lat) * 111.2,
        (mLon - lon) * 111.2 * Math.cos((lat * Math.PI) / 180),
      );
      expect([lat, km <= CELL_KM]).toEqual([lat, true]);
    }
  });
});

describe('the city table', () => {
  it('finds the cell for an IPv4 and an IPv6 address', () => {
    const table = build([
      ['10.0.0.0', '10.0.255.255', 'DE', BERLIN],
      ['2001:db8::', '2001:db8:ff:ffff:ffff:ffff:ffff:ffff', 'FR', PARIS],
    ]);
    expect(placeOf(table, '10.0.12.34')).toEqual(cell('DE', BERLIN));
    expect(placeOf(table, '2001:db8:12::1')).toEqual(cell('FR', PARIS));
    expect(table.header).toMatchObject({ month: '2026-10', license: 'CC BY 4.0' });
  });

  it('has no place outside the ranges, in a gap, or in ZZ space', () => {
    const table = build([
      ['0.0.0.0', '0.255.255.255', 'ZZ', [0, 0]],
      ['10.0.0.0', '10.0.3.255', 'DE', BERLIN],
      ['10.0.16.0', '10.0.19.255', 'DE', MUNICH],
      ['2001:db8::', '2001:db8:ff:ffff:ffff:ffff:ffff:ffff', 'FR', PARIS],
    ]);
    for (const ip of ['0.1.2.3', '9.255.255.255', '10.0.8.1', '10.0.20.0', '2001:db9::1', '::1']) {
      expect([ip, cityPlaceIn(table, ip)]).toEqual([ip, null]);
    }
    expect(placeOf(table, '10.0.17.1')).toEqual(cell('DE', MUNICH));
  });

  it('gives a shared IPv4 /22 the cell covering the most addresses', () => {
    // 10.1.0.0/22: 256 addresses in Berlin, 768 in Munich.
    const table = build([
      ['10.1.0.0', '10.1.0.255', 'DE', BERLIN],
      ['10.1.1.0', '10.1.3.255', 'DE', MUNICH],
    ]);
    expect(placeOf(table, '10.1.0.1')).toEqual(cell('DE', MUNICH));
    expect(placeOf(table, '10.1.3.1')).toEqual(cell('DE', MUNICH));
  });

  it('gives a shared IPv6 /40 the cell covering the most addresses', () => {
    const table = build([
      ['2001:db8::', '2001:db8:0:ffff:ffff:ffff:ffff:ffff', 'FR', PARIS],
      ['2001:db8:1::', '2001:db8:ff:ffff:ffff:ffff:ffff:ffff', 'DE', BERLIN],
    ]);
    expect(placeOf(table, '2001:db8::1')).toEqual(cell('DE', BERLIN));
  });

  it('keeps whole blocks exact when a range spans many', () => {
    const table = build([
      ['10.2.0.0', '10.2.0.255', 'DE', BERLIN],
      ['10.2.1.0', '10.2.255.255', 'FR', PARIS],
    ]);
    // The first /22 is mostly Paris; every later block is Paris outright.
    expect(placeOf(table, '10.2.0.1')).toEqual(cell('FR', PARIS));
    expect(placeOf(table, '10.2.200.1')).toEqual(cell('FR', PARIS));
    expect(cityPlaceIn(table, '10.3.0.0')).toBeNull();
  });

  it('merges neighboring blocks in one cell into one row', () => {
    const table = build([
      ['10.4.0.0', '10.4.3.255', 'DE', BERLIN],
      ['10.4.4.0', '10.4.7.255', 'DE', [52.53, 13.41]],
    ]);
    const { starts, countries } = table.families[4];
    const real = [...starts].filter((_, i) => countries[i] !== 0);
    expect(real).toEqual([(10 * 2 ** 24 + 4 * 2 ** 16) >>> 0]);
  });

  it('refuses a file that is not one, or is cut short', () => {
    expect(() => decodeCityTable(Buffer.from('not a geo file at all'))).toThrow();
    const good = encodeCityTable(createCityTableBuilder().finish());
    expect(() => decodeCityTable(good.subarray(0, good.length - 8))).toThrow();
  });
});
