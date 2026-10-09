import { describe, expect, it } from 'vitest';
import { geoDistance, geoInterpolate, geoNaturalEarth1, geoOrthographic } from 'd3-geo';
import {
  destinationOf,
  facesViewer,
  flightSeconds,
  FLIGHT_DEGREES_PER_SECOND,
  launchDelays,
  liftedPoint,
  localeHome,
  scatter,
  SCATTER_DEGREES,
  wrapsAround,
} from '../../../src/utils/resolution-map-geometry.js';
import { COUNTRY_GEO } from '../../../src/utils/country-geo.js';
import { COUNTRIES } from '../../../src/utils/countries.js';

const HOME = [-75.16, 39.95];
const TOKYO = [139.69, 35.69];

describe('where an event lands', () => {
  it('uses the city point when there is one', () => {
    expect(destinationOf({ kind: 'answer', country: 'JP', point: TOKYO })).toEqual(TOKYO);
  });

  it("falls back to its country's middle, scattered by name and the same each time", () => {
    const event = { kind: 'answer', country: 'DE', point: null, name: 'www.hetzner.com' };
    const [lon, lat] = destinationOf(event);
    const [mLon, mLat] = COUNTRY_GEO.DE.at;
    expect(Math.abs(lon - mLon) <= SCATTER_DEGREES[0] / 2).toBe(true);
    expect(Math.abs(lat - mLat) <= SCATTER_DEGREES[1] / 2).toBe(true);
    expect(destinationOf(event)).toEqual([lon, lat]);
    expect(scatter(COUNTRY_GEO.DE.at, 'other.example')).not.toEqual([lon, lat]);
  });

  it('lands nowhere without a place', () => {
    expect(destinationOf({ kind: 'blocklist', country: null, point: null })).toBeNull();
    expect(destinationOf({ kind: 'answer', country: 'QQ', point: null })).toBeNull();
  });

  it('keeps a scattered point on the globe near a pole', () => {
    for (let i = 0; i < 50; i++) {
      const [, lat] = scatter([0, 88.9], `n${i}`);
      expect(lat <= 89).toBe(true);
    }
  });
});

describe('the country table', () => {
  it('has a landing point for every country the app names', () => {
    const missing = COUNTRIES.map((c) => c.code).filter((code) => !COUNTRY_GEO[code]);
    expect(missing).toEqual([]);
  });

  it('puts each point on the globe', () => {
    for (const [code, { at }] of Object.entries(COUNTRY_GEO)) {
      expect([code, Math.abs(at[0]) <= 180 && Math.abs(at[1]) <= 90]).toEqual([code, true]);
    }
  });
});

describe('home without a setting', () => {
  it("takes the browser locale's country", () => {
    expect(localeHome(['en-US'])).toEqual(COUNTRY_GEO.US.at);
    expect(localeHome(['de-DE', 'en'])).toEqual(COUNTRY_GEO.DE.at);
    expect(localeHome(['xx', 'not a tag!'])).toBeNull();
  });
});

describe('a flight', () => {
  const flight = { home: HOME, dest: TOKYO, interp: geoInterpolate(HOME, TOKYO) };

  it('starts at home and ends at the destination, lifted in between', () => {
    for (const [mode, projection] of [
      ['map', geoNaturalEarth1().fitSize([1000, 500], { type: 'Sphere' })],
      ['globe', geoOrthographic().fitSize([800, 800], { type: 'Sphere' }).rotate([-30, -40])],
    ]) {
      const start = liftedPoint(projection, mode, flight, 0);
      const end = liftedPoint(projection, mode, flight, 1);
      expect(start.map(Math.round)).toEqual(projection(HOME).map(Math.round));
      expect(end.map(Math.round)).toEqual(projection(TOKYO).map(Math.round));
    }
    const map = geoNaturalEarth1().fitSize([1000, 500], { type: 'Sphere' });
    const mid = liftedPoint(map, 'map', flight, 0.5);
    expect(mid[1] < map(flight.interp(0.5))[1]).toBe(true);
    // On the globe the lift is outward from the middle of the disc.
    const globe = geoOrthographic().fitSize([800, 800], { type: 'Sphere' }).rotate([-30, -40]);
    const surface = globe(flight.interp(0.5));
    const lifted = liftedPoint(globe, 'globe', flight, 0.5);
    const fromMiddle = ([x, y]) => Math.hypot(x - 400, y - 400);
    expect(fromMiddle(lifted) > fromMiddle(surface)).toBe(true);
  });

  it('hides the far side of the globe', () => {
    const facing = [-HOME[0], -HOME[1]];
    expect(facesViewer(HOME, facing, geoDistance)).toBe(true);
    expect(facesViewer([HOME[0] + 180, -HOME[1]], facing, geoDistance)).toBe(false);
  });

  it('breaks a trail that jumps across the flat map', () => {
    expect(wrapsAround([990, 200], [10, 205], 1000)).toBe(true);
    expect(wrapsAround([500, 200], [520, 210], 1000)).toBe(false);
    expect(wrapsAround(null, [10, 205], 1000)).toBe(false);
  });
});

describe('spreading one poll over the next', () => {
  it('keeps the server order and spacing within the span', () => {
    const delays = launchDelays([{ at: 1000 }, { at: 1500 }, { at: 3000 }], 2000);
    expect(delays[0]).toBe(0);
    expect(delays[1] < delays[2]).toBe(true);
    expect(delays[2] < 2000).toBe(true);
  });

  it('spaces events with one timestamp evenly', () => {
    expect(launchDelays([{ at: 5 }, { at: 5 }], 2000)).toEqual([0, 1000]);
    expect(launchDelays([], 2000)).toEqual([]);
  });
});

describe('flight time', () => {
  it('grows with distance, so every flight moves at one pace', () => {
    const near = flightSeconds(HOME, [-73.99, 40.73]);
    const far = flightSeconds(HOME, TOKYO);
    const halfway = flightSeconds([0, 0], [90, 0]);
    expect(near).toBe(0.8);
    expect(halfway).toBeCloseTo(90 / FLIGHT_DEGREES_PER_SECOND, 5);
    expect(far > halfway).toBe(true);
  });
});
