/**
 * Scanner chip state, derived once.
 *
 * The header used to answer this question four separate times (duplicate-logic
 * audit #55): the chip label, the tooltip on that same button, the chip CSS
 * class and the status dot each had their own logic. A queued-but-not-running
 * scan rendered as "Scanner pending" in the label, "Scanner Active" in the
 * tooltip, an active chip, and an OK dot, so one button showed three different
 * states at once.
 *
 * A plain function rather than a computed inside HeaderBar.vue so it can be
 * imported and tested directly. A test that restates the rule instead of
 * importing it passes no matter what the component does.
 *
 * @param {Array} activeScans rows from GET /api/scans with status 'running' or 'pending'
 * @returns {{label: string, dot: string, dotLabel: string, chipClass: string}}
 *          `dot` is always one of StatusDot's accepted kinds.
 */
export function deriveScanState(activeScans) {
  const scans = Array.isArray(activeScans) ? activeScans : [];
  if (!scans.length) {
    return { label: 'Scanner idle', dot: 'muted', dotLabel: 'Idle', chipClass: 'chip-idle' };
  }

  const running = scans.filter(s => s && s.status === 'running');
  if (!running.length) {
    // Queued but not started. Not idle, not yet active, and not a fault.
    return { label: 'Scanner pending', dot: 'info', dotLabel: 'Pending', chipClass: 'chip-active' };
  }

  const totalIps = running.reduce((sum, s) => sum + (s.total_ips || 0), 0);
  const scannedIps = running.reduce((sum, s) => sum + (s.scanned_ips || 0), 0);
  const pct = totalIps > 0 ? Math.round((scannedIps / totalIps) * 100) : null;
  return {
    label: pct === null ? 'Scanner active' : `Scanner active ${pct}%`,
    dot: 'ok',
    dotLabel: 'OK',
    chipClass: 'chip-active',
  };
}
