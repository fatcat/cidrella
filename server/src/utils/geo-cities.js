// City-level places for the Resolution Map, from DB-IP City Lite (CC BY 4.0).
//
// scripts/build-geo-cities.js turns the CSV into geo-cities.bin at release
// build time; this module owns the coarsening, the file format and the
// lookup, so the script and the server cannot disagree about either.
//
// Coarsening: every location snaps to a grid cell about CELL_KM across, and
// addresses are grouped in blocks (IPv4 /22, IPv6 /40). A block one range
// covers takes that range's cell; a block several ranges share takes the
// cell covering the most addresses. Measured on the 2026-10 file: 7.79 M rows
// become about 1.4 M, and about 8% of IPv4 addresses land one cell off. On a
// world map that is invisible, and it keeps the file near 4 MB gzipped.
//
// File layout, little-endian, every section 8-byte aligned:
//   'CIDRGEO1', u32 header length, header JSON (padded),
//   then per family: starts, countries (u16, two ASCII letters, 0 = no data),
//   lat and lon (i16, hundredths of a degree). IPv4 starts are u32 addresses,
//   IPv6 starts are f64 /40 block numbers (exact below 2^53).
// A row runs until the next row's start; a gap DB-IP does not cover is a row
// with country 0.
import fs from 'node:fs';
import { parseIp } from './address.js';

export const CELL_KM = 100;
export const GEO_ATTRIBUTION = 'IP Geolocation by DB-IP';
const MAGIC = 'CIDRGEO1';
const FAMILIES = {
  4: { bits: 32, blockBits: 22 },
  6: { bits: 128, blockBits: 40 },
};
const KM_PER_DEGREE = 111.2;
const LAT_STEP = CELL_KM / KM_PER_DEGREE;

/** The middle of the ~CELL_KM cell a point falls in, as [lat, lon]. */
export function cellMiddle(lat, lon) {
  const row = Math.floor((lat + 90) / LAT_STEP);
  const midLat = Math.min(90, -90 + (row + 0.5) * LAT_STEP);
  // Longitude steps widen toward the poles so a cell stays about square.
  const lonStep = Math.min(360, LAT_STEP / Math.max(Math.cos((midLat * Math.PI) / 180), 0.05));
  const col = Math.floor((lon + 180) / lonStep);
  const midLon = Math.min(180, -180 + (col + 0.5) * lonStep);
  return [midLat, midLon];
}

/**
 * Builds the coarsened table from ranges in address order. Feed it with
 * add(start, end, country, lat, lon) per CSV row (addresses as strings);
 * finish() returns { 4: rows, 6: rows }, each row { start, end, country,
 * lat, lon } with block numbers and hundredths of a degree.
 */
export function createCityTableBuilder() {
  const state = { 4: { rows: [], vote: null }, 6: { rows: [], vote: null } };

  function emit(family, start, end, place) {
    const rows = state[family].rows;
    const last = rows[rows.length - 1];
    if (last && last.key === place.key && last.end + 1 === start) {
      last.end = end;
      return;
    }
    rows.push({ start, end, ...place });
  }

  function flush(family) {
    const vote = state[family].vote;
    if (!vote) return;
    let best = null;
    for (const entry of vote.places.values()) if (!best || entry.weight > best.weight) best = entry;
    emit(family, vote.block, vote.block, best.place);
    state[family].vote = null;
  }

  function cast(family, block, place, weight) {
    let vote = state[family].vote;
    if (vote && vote.block !== block) {
      flush(family);
      vote = null;
    }
    if (!vote) vote = state[family].vote = { block, places: new Map() };
    const entry = vote.places.get(place.key);
    if (entry) entry.weight += weight;
    else vote.places.set(place.key, { place, weight });
  }

  function add(startIp, endIp, country, lat, lon) {
    const a = parseIp(startIp, { zoneId: false, mapV4: false });
    const b = parseIp(endIp, { zoneId: false, mapV4: false });
    if (!a || !b || a.bits !== b.bits) return;
    // ZZ marks reserved space: no place, so it votes for nothing.
    if (!/^[A-Z]{2}$/.test(country) || country === 'ZZ') return;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const family = a.bits === 32 ? 4 : 6;
    const shift = BigInt(FAMILIES[family].bits - FAMILIES[family].blockBits);
    const [midLat, midLon] = cellMiddle(lat, lon);
    const place = {
      country,
      lat: Math.round(midLat * 100),
      lon: Math.round(midLon * 100),
    };
    place.key = `${country}:${place.lat}:${place.lon}`;

    const first = a.value >> shift;
    const last = b.value >> shift;
    const blockEnd = (block) => ((block + 1n) << shift) - 1n;
    const min = (x, y) => (x < y ? x : y);
    cast(family, Number(first), place, Number(min(b.value, blockEnd(first)) - a.value + 1n));
    if (last === first) return;
    if (last > first + 1n) {
      flush(family);
      emit(family, Number(first + 1n), Number(last - 1n), place);
    }
    cast(family, Number(last), place, Number(b.value - (last << shift) + 1n));
  }

  function finish() {
    flush(4);
    flush(6);
    return { 4: state[4].rows, 6: state[6].rows };
  }

  return { add, finish };
}

const align8 = (n) => Math.ceil(n / 8) * 8;
const countryCode = (cc) => (cc ? (cc.charCodeAt(0) << 8) | cc.charCodeAt(1) : 0);

/** Lays rows out as the arrays the file stores, with gap rows filled in. */
function toColumns(family, rows) {
  const out = [];
  for (const row of rows) {
    const prev = out[out.length - 1];
    if (prev && prev.end + 1 < row.start) out.push({ start: prev.end + 1, end: row.start - 1 });
    out.push(row);
  }
  const last = out[out.length - 1];
  const lastBlock = 2 ** FAMILIES[family].blockBits - 1;
  if (last && last.end < lastBlock) out.push({ start: last.end + 1, end: lastBlock });
  const shift = FAMILIES[family].bits - FAMILIES[family].blockBits;
  const starts = family === 4 ? new Uint32Array(out.length) : new Float64Array(out.length);
  const countries = new Uint16Array(out.length);
  const lats = new Int16Array(out.length);
  const lons = new Int16Array(out.length);
  out.forEach((row, i) => {
    // IPv4 starts are stored as addresses (a /22 block times 1024).
    starts[i] = family === 4 ? row.start * 2 ** shift : row.start;
    countries[i] = countryCode(row.country);
    lats[i] = row.lat ?? 0;
    lons[i] = row.lon ?? 0;
  });
  return { starts, countries, lats, lons };
}

/** Encodes a finished table, plus header facts (month, source), as a Buffer. */
export function encodeCityTable(table, facts = {}) {
  const columns = { 4: toColumns(4, table[4]), 6: toColumns(6, table[6]) };
  const sections = [];
  const header = {
    format: 1,
    source: 'DB-IP City Lite',
    license: 'CC BY 4.0',
    attribution: GEO_ATTRIBUTION,
    cellKm: CELL_KM,
    ...facts,
    families: {},
  };
  for (const family of [4, 6]) {
    const c = columns[family];
    header.families[family] = {
      rows: c.starts.length,
      blockBits: FAMILIES[family].blockBits,
      sections: ['starts', 'countries', 'lats', 'lons'],
    };
    sections.push(c.starts, c.countries, c.lats, c.lons);
  }
  // Offsets depend on the header's own length, so settle them in two passes.
  let headerBytes = Buffer.from(JSON.stringify(header));
  for (let pass = 0; pass < 2; pass++) {
    let offset = align8(MAGIC.length + 4 + headerBytes.length);
    header.offsets = sections.map((s) => {
      const at = offset;
      offset = align8(offset + s.byteLength);
      return at;
    });
    header.length = offset;
    headerBytes = Buffer.from(JSON.stringify(header));
  }
  const buf = Buffer.alloc(header.length);
  buf.write(MAGIC, 0, 'ascii');
  buf.writeUInt32LE(headerBytes.length, MAGIC.length);
  headerBytes.copy(buf, MAGIC.length + 4);
  sections.forEach((s, i) => {
    Buffer.from(s.buffer, s.byteOffset, s.byteLength).copy(buf, header.offsets[i]);
  });
  return buf;
}

/** Decodes a geo-cities.bin buffer into lookup arrays. Throws on a bad file. */
export function decodeCityTable(buf) {
  if (buf.toString('ascii', 0, MAGIC.length) !== MAGIC) throw new Error('not a geo-cities file');
  const headerLength = buf.readUInt32LE(MAGIC.length);
  const header = JSON.parse(
    buf.toString('utf8', MAGIC.length + 4, MAGIC.length + 4 + headerLength),
  );
  if (header.format !== 1 || header.length !== buf.length) {
    throw new Error('unsupported or truncated geo-cities file');
  }
  // Copy into one aligned buffer so typed arrays can view it directly.
  const bytes = new Uint8Array(buf.length);
  bytes.set(buf);
  const view = (Type, offset, rows) => new Type(bytes.buffer, offset, rows);
  const families = {};
  let section = 0;
  for (const family of [4, 6]) {
    const { rows } = header.families[family];
    const at = () => header.offsets[section++];
    families[family] = {
      starts: view(family === 4 ? Uint32Array : Float64Array, at(), rows),
      countries: view(Uint16Array, at(), rows),
      lats: view(Int16Array, at(), rows),
      lons: view(Int16Array, at(), rows),
    };
  }
  return { header, families };
}

/** The last index whose start is <= key, or -1. */
function floorIndex(starts, key) {
  let lo = 0;
  let hi = starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid] <= key) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** The place an address falls in: { country, lat, lon }, or null. */
export function cityPlaceIn(table, ip) {
  const parsed = parseIp(ip, { zoneId: false });
  if (!table || !parsed) return null;
  const family = parsed.bits === 32 ? 4 : 6;
  const columns = table.families[family];
  const key =
    family === 4
      ? Number(parsed.value)
      : Number(parsed.value >> BigInt(128 - FAMILIES[6].blockBits));
  const i = floorIndex(columns.starts, key);
  if (i < 0 || columns.countries[i] === 0) return null;
  const code = columns.countries[i];
  return {
    country: String.fromCharCode(code >> 8, code & 0xff),
    lat: columns.lats[i] / 100,
    lon: columns.lons[i] / 100,
  };
}

// ─── The table the proxy uses ───────────────────────────────────────────────
// Shipped at server/assets/geo-cities.bin (not in DATA_DIR: it comes with the
// release, like the code). Loaded once, only while GeoIP is on.
const DEFAULT_PATH = new URL('../../assets/geo-cities.bin', import.meta.url);
let loaded = null;

/** Loads the shipped table. Returns true when city places are available. */
export function loadCityTable(file = DEFAULT_PATH) {
  try {
    loaded = decodeCityTable(fs.readFileSync(file));
    return true;
  } catch {
    loaded = null;
    return false;
  }
}

export function unloadCityTable() {
  loaded = null;
}

/** The loaded table's header (month, attribution), or null. */
export function cityTableInfo() {
  return loaded ? loaded.header : null;
}

/** The city place for an address from the loaded table, or null. */
export function cityPlace(ip) {
  return loaded ? cityPlaceIn(loaded, ip) : null;
}
