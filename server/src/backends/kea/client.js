/**
 * Kea's HTTP control API: one POST per command, basic auth, a JSON reply
 * that is a list with one answer per daemon. Result 0 is success and 3 is
 * "nothing found" (an empty lease page, an unknown lease); anything else is
 * an error and throws a KeaError naming the command.
 */
export class KeaError extends Error {
  constructor(message, { command, result = null, status = null } = {}) {
    super(message);
    this.name = 'KeaError';
    this.command = command;
    this.result = result;
    this.status = status;
  }
}

export const KEA_EMPTY = 3;

/**
 * `password()` is read per call, so a secret created after the client still
 * works. `fetchImpl` is for tests.
 */
export function createKeaClient({
  port,
  user,
  password,
  host = '127.0.0.1',
  timeoutMs = 5000,
  fetchImpl = fetch,
}) {
  const url = `http://${host}:${port}/`;
  return async function command(name, args) {
    const auth = Buffer.from(`${user}:${password() ?? ''}`).toString('base64');
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
        body: JSON.stringify(
          args === undefined ? { command: name } : { command: name, arguments: args },
        ),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new KeaError(`Kea did not answer ${name} on ${url}: ${err.message}`, { command: name });
    }
    if (res.status === 401) {
      throw new KeaError(`Kea refused CIDRella's credentials for ${name} (HTTP 401)`, {
        command: name,
        status: 401,
      });
    }
    if (!res.ok) {
      throw new KeaError(`Kea answered ${name} with HTTP ${res.status}`, {
        command: name,
        status: res.status,
      });
    }
    let body;
    try {
      body = await res.json();
    } catch {
      throw new KeaError(`Kea's reply to ${name} was not JSON`, { command: name });
    }
    const reply = Array.isArray(body) ? body[0] : body;
    if (reply?.result === 0 || reply?.result === KEA_EMPTY) {
      return {
        result: reply.result,
        empty: reply.result === KEA_EMPTY,
        text: reply.text ?? null,
        arguments: reply.arguments ?? null,
      };
    }
    throw new KeaError(
      `Kea ${name} failed (result ${reply?.result ?? 'missing'}): ${reply?.text || 'no reason given'}`,
      { command: name, result: reply?.result ?? null },
    );
  };
}
