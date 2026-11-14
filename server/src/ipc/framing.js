/**
 * The framing every CIDRella process socket uses (the DNS proxy, the
 * privileged helper): one JSON object per line, each with a string `type`. A
 * line longer than MAX_LINE_BYTES ends the connection, so a confused peer
 * cannot make the other side buffer without limit.
 */
import { StringDecoder } from 'string_decoder';

export const MAX_LINE_BYTES = 1024 * 1024;

export function encode(message) {
  return `${JSON.stringify(message)}\n`;
}

/**
 * A line splitter for one connection. `onMessage` gets each parsed object;
 * `onError` gets an oversized line or one that is not a JSON object, and the
 * caller ends the connection.
 */
export function createDecoder(onMessage, onError) {
  let pending = '';
  let failed = false;
  // A character split across two reads stays whole.
  const utf8 = new StringDecoder('utf8');
  return function feed(chunk) {
    if (failed) return;
    pending += typeof chunk === 'string' ? chunk : utf8.write(chunk);
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        message = null;
      }
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
        failed = true;
        onError(new Error('not a protocol message'));
        return;
      }
      onMessage(message);
    }
    if (Buffer.byteLength(pending) > MAX_LINE_BYTES) {
      failed = true;
      onError(new Error(`a line passed ${MAX_LINE_BYTES} bytes`));
    }
  };
}
