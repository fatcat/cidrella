/**
 * How a lease report travels (POST /api/sync/leases): the JSON, gzipped, as
 * `application/gzip`. A network's leases run to megabytes of JSON, and the
 * app's JSON parser stops at 100 KB; it reads only JSON bodies, so this type
 * passes it untouched and the route unpacks the body itself, under its own
 * limits. Both ends import this.
 */
import { promisify } from 'util';
import zlib from 'zlib';

const gunzip = promisify(zlib.gunzip);

export const LEASE_REPORT_TYPE = 'application/gzip';
// The code of the 409 a report gets from an instance whose leases do not count.
export const NOT_DHCP_ACTIVE = 'not_dhcp_active';
// The body as it arrives, and as it unpacks.
export const MAX_REPORT_BYTES = 16 * 1024 * 1024;
// 150,000 leases at about 250 bytes each, with room to spare.
const MAX_UNPACKED_BYTES = 48 * 1024 * 1024;

/** A report as it is sent. */
export const packReport = (body) => zlib.gzipSync(JSON.stringify(body));

/**
 * The body of a report as an object, or null when it is not readable.
 * Unpacked off the event loop: a small body can hold a great deal.
 */
export async function unpackReport(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  try {
    const text = await gunzip(buffer, { maxOutputLength: MAX_UNPACKED_BYTES });
    const body = JSON.parse(text.toString('utf8'));
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}
