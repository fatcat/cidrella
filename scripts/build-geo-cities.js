#!/usr/bin/env node
// Builds server/assets/geo-cities.bin, the city places behind the Resolution
// Map, from DB-IP City Lite (CC BY 4.0, free, no account). build-release.sh
// runs it when routine updates are accepted or the file is missing; run it by
// hand with `npm run geo:cities`. The coarsening and the file format live in
// server/src/utils/geo-cities.js.
//
//   node scripts/build-geo-cities.js [--csv file.csv.gz] [--out file]
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const zlib = require('zlib');
const { Readable } = require('stream');

const projectDir = path.resolve(__dirname, '..');
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};
const outFile = path.resolve(arg('--out') || path.join(projectDir, 'server/assets/geo-cities.bin'));
const csvFile = arg('--csv');

// start, end, continent, country, region, city, lat, lon; region and city may
// be quoted and hold commas.
const ROW_RE =
  /^([^,]+),([^,]+),[^,]*,([^,]*),(?:"(?:[^"]|"")*"|[^,]*),(?:"(?:[^"]|"")*"|[^,]*),([^,]*),([^,]*)$/;

function monthOf(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

// DB-IP publishes early in the month; fall back to last month's file.
async function openDownload() {
  const now = new Date();
  const months = [
    monthOf(now),
    monthOf(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))),
  ];
  for (const month of months) {
    const url = `https://download.db-ip.com/free/dbip-city-lite-${month}.csv.gz`;
    console.log(`  Downloading ${url}`);
    const response = await fetch(url, { headers: { 'User-Agent': 'CIDRella-build/1.0' } });
    if (response.ok) return { stream: Readable.fromWeb(response.body), month };
    console.log(`  ${url}: HTTP ${response.status}`);
  }
  throw new Error(`no DB-IP City Lite file for ${months.join(' or ')}`);
}

async function main() {
  const { createCityTableBuilder, encodeCityTable } = await import(
    path.join(projectDir, 'server/src/utils/geo-cities.js')
  );
  const source = csvFile
    ? {
        stream: fs.createReadStream(csvFile),
        month: (path.basename(csvFile).match(/\d{4}-\d{2}/) || ['unknown'])[0],
      }
    : await openDownload();

  const builder = createCityTableBuilder();
  const input = readline.createInterface({
    input: source.stream.pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });
  let read = 0;
  let skipped = 0;
  for await (const line of input) {
    const m = ROW_RE.exec(line);
    if (!m) {
      skipped++;
      continue;
    }
    builder.add(m[1], m[2], m[3], Number(m[4]), Number(m[5]));
    read++;
  }
  if (read === 0) throw new Error('the CSV had no rows');

  const table = builder.finish();
  const buf = encodeCityTable(table, { month: source.month });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const tmp = `${outFile}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, outFile);
  const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
  console.log(
    `  City places for ${source.month}: ${read} rows read (${skipped} skipped), ` +
      `${table[4].length} IPv4 and ${table[6].length} IPv6 rows kept, ` +
      `${mb(buf.length)} (${mb(zlib.gzipSync(buf).length)} gzipped) -> ${path.relative(projectDir, outFile)}`,
  );
}

main().catch((err) => {
  console.error(`build-geo-cities: ${err.message}`);
  process.exit(1);
});
