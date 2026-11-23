/**
 * The HTTP client instances use to talk to each other
 * (docs/REDUNDANCY-PLAN.md, Trust and pairing). It is the only client allowed
 * to call a private or loopback address, and it may because it trusts exactly
 * one certificate: the peer's sync identity, by SHA-256 fingerprint. The
 * system CA store, the certificate's names and its dates play no part.
 * Everything else that fetches a URL goes through utils/url-guard.js.
 *
 * The TLS connection is made here and the pin checked before the socket is
 * handed to the HTTP layer, so a peer with the wrong certificate never sees a
 * request line, a header or the credential.
 */
import http from 'http';
import { PassThrough } from 'stream';
import tls from 'tls';
import zlib from 'zlib';
import { SYNC_SERVER_NAME, fingerprintOfCert } from '../sync/identity.js';
import { formatHostPort } from './address.js';

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const FINGERPRINT = /^[0-9a-f]{64}$/;

function fail(code, message, cause) {
  const err = new Error(message, cause ? { cause } : undefined);
  err.code = code;
  return err;
}

/**
 * One request to another instance.
 *
 * `address` is a host name, an IPv4 address or a bare IPv6 address.
 * `fingerprint` is the peer's sync identity, 64 hex characters. `body` is a
 * Buffer or string sent as is, or a plain object sent as JSON. `credential`
 * goes out as a bearer token. `timeoutMs` covers the whole exchange, connect
 * to last byte. `maxBytes` caps the response body, before and after gunzip.
 *
 * Resolves `{ status, headers, body }`, body a Buffer, gunzipped when the
 * response says gzip. Any status resolves, a redirect included: it is never
 * followed. Rejects with an Error whose `code` is `pin_mismatch`,
 * `unreachable` (no connection, or one that dropped), `timeout`, `too_large`,
 * or `bad_response` (a gzip body that does not decode).
 *
 * `consume`, when given, takes a 200 answer as it arrives instead: it is
 * called with the body as a stream of Buffers (gunzipped, `maxBytes` still
 * the cap), and the request resolves with what it resolves to as `body`. A
 * fault of the stream reaches it as an error with one of the codes above;
 * whatever it rejects with, the request rejects with, and only once it has
 * finished, so a file it writes is closed by then. Any other status is read
 * as usual.
 */
export function syncRequest({
  address,
  port = 443,
  fingerprint,
  method = 'GET',
  path,
  headers = {},
  body = null,
  credential = null,
  timeoutMs = 30000,
  maxBytes = DEFAULT_MAX_BYTES,
  consume = null,
}) {
  const peer = formatHostPort(address, port);
  const pin = String(fingerprint ?? '').toLowerCase();

  return new Promise((resolve, reject) => {
    if (!FINGERPRINT.test(pin)) {
      reject(
        new TypeError(
          `No usable certificate fingerprint for ${peer}: expected 64 hex characters (SHA-256)`,
        ),
      );
      return;
    }

    let socket = null;
    let req = null;
    let consuming = null;
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (fn === reject) {
        req?.destroy();
        socket?.destroy();
      }
      // A consumer still reading is let finish before the caller hears.
      if (consuming) {
        const tell = () => fn(value);
        consuming.then(tell, tell);
      } else {
        fn(value);
      }
    };
    const timer = setTimeout(
      () => settle(reject, fail('timeout', `No answer from ${peer} within ${timeoutMs} ms`)),
      timeoutMs,
    );
    const unreachable = (what) => (err) =>
      settle(reject, fail('unreachable', `${what} ${peer}: ${err?.message || err}`, err));

    // rejectUnauthorized is off because the pin below is the whole trust
    // decision: a self-signed identity never passes the CA check anyway.
    socket = tls.connect({
      host: address,
      port,
      servername: SYNC_SERVER_NAME,
      rejectUnauthorized: false,
      ALPNProtocols: ['http/1.1'],
    });
    socket.once('error', unreachable('Could not connect to'));

    socket.once('secureConnect', () => {
      let presented;
      try {
        presented = fingerprintOfCert(socket.getPeerCertificate().raw);
      } catch {
        presented = null;
      }
      if (presented !== pin) {
        settle(
          reject,
          fail(
            'pin_mismatch',
            `The certificate ${peer} presented is not the one expected for that instance ` +
              `(got SHA-256 ${presented || 'nothing readable'}, expected ${pin}). ` +
              'Nothing was sent to it.',
          ),
        );
        return;
      }
      send();
    });

    function send() {
      const out = { host: peer, 'accept-encoding': 'gzip' };
      for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value;

      let payload = null;
      if (body !== null && body !== undefined) {
        if (Buffer.isBuffer(body) || typeof body === 'string') {
          payload = Buffer.from(body);
        } else {
          payload = Buffer.from(JSON.stringify(body));
          out['content-type'] = 'application/json';
        }
        out['content-length'] = payload.length;
      }
      if (credential) out.authorization = `Bearer ${credential}`;

      req = http.request({
        // The checked socket, and no agent: giving createConnection without
        // one is what makes Node use it (agent: false would dial its own).
        createConnection: () => socket,
        method,
        path,
        headers: { ...out, connection: 'close' },
      });
      req.once('error', unreachable('Lost the connection to'));
      req.once('response', (res) => receive(res));
      req.end(payload ?? undefined);
    }

    function receive(res) {
      const tooLarge = () =>
        settle(
          reject,
          fail('too_large', `The response from ${peer} is larger than ${maxBytes} bytes`),
        );
      if (Number(res.headers['content-length']) > maxBytes) return tooLarge();
      if (consume && res.statusCode === 200) return stream(res);

      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) return tooLarge();
        chunks.push(chunk);
      });
      res.once('error', unreachable('Lost the connection to'));
      res.once('close', () => {
        if (!res.complete) unreachable('Lost the connection to')(new Error('response cut short'));
      });
      res.once('end', () => {
        const raw = Buffer.concat(chunks);
        const done = (bodyOut) => {
          settle(resolve, { status: res.statusCode, headers: res.headers, body: bodyOut });
          socket.destroy();
        };
        if (String(res.headers['content-encoding'] || '').toLowerCase() !== 'gzip') {
          return done(raw);
        }
        zlib.gunzip(raw, { maxOutputLength: maxBytes }, (err, plain) => {
          if (!err) return done(plain);
          if (err.code === 'ERR_BUFFER_TOO_LARGE') return tooLarge();
          settle(
            reject,
            fail('bad_response', `Unreadable gzip response from ${peer}: ${err.message}`, err),
          );
        });
      });
    }

    // The body of `res` to `consume` as it arrives, read no faster than it
    // is taken.
    function stream(res) {
      const out = new PassThrough();
      // A fault before the consumer starts reading waits in `out` for it.
      out.on('error', () => {});
      const fault = (err) => {
        if (!out.destroyed) out.destroy(err);
      };
      const tooLarge = () =>
        fault(fail('too_large', `The response from ${peer} is larger than ${maxBytes} bytes`));
      const lost = (why) => fault(fail('unreachable', `Lost the connection to ${peer}: ${why}`));

      let source = res;
      if (String(res.headers['content-encoding'] || '').toLowerCase() === 'gzip') {
        source = res.pipe(zlib.createGunzip());
        source.on('error', (err) =>
          fault(fail('bad_response', `Unreadable gzip response from ${peer}: ${err.message}`, err)),
        );
        let raw = 0;
        res.on('data', (chunk) => {
          raw += chunk.length;
          if (raw > maxBytes) tooLarge();
        });
      }
      let size = 0;
      source.on('data', (chunk) => {
        if (out.destroyed) return;
        size += chunk.length;
        if (size > maxBytes) return tooLarge();
        if (!out.write(chunk)) source.pause();
      });
      out.on('drain', () => source.resume());
      source.once('end', () => out.end());
      res.on('error', (err) => lost(err.message));
      res.once('close', () => {
        if (!res.complete) lost('response cut short');
      });

      consuming = Promise.resolve()
        .then(() => consume(out))
        .then(
          (value) => {
            out.destroy();
            return { value };
          },
          (error) => {
            out.destroy();
            return { error };
          },
        );
      void consuming.then(({ value, error }) => {
        if (error) return settle(reject, error);
        settle(resolve, { status: res.statusCode, headers: res.headers, body: value });
        socket.destroy();
      });
    }
  });
}
