/**
 * Starting, reloading and checking a backend daemon. Native installs run it
 * as its own systemd unit, which the cidrella account may restart and reload
 * (polkit, /etc/polkit-1/rules.d/49-cidrella.rules; no sudo, since
 * cidrella.service runs with NoNewPrivileges). Docker has no systemctl: s6
 * supervises the daemon, so a signal by process name does the same job.
 *
 * A restart that fails both ways leaves a marker, so the next boot restarts
 * even when change detection sees nothing new: the files on disk may be
 * ahead of what the running daemon loaded.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { emitUnitEvent } from './unit-events.js';

const stderrOf = (err) => err?.stderr?.toString?.().trim();

/**
 * `unit` is the systemd unit, `processName` the executable s6 runs, and
 * `pidFile` (optional) where the daemon writes its pid, for a reload signal
 * aimed at one process rather than every process of that name.
 *
 * `enableFile` (optional) is for a daemon s6 keeps down until it is wanted
 * (Kea, which runs only while it serves DHCP): its run script waits for the
 * file. `disableFile` (optional) is the reverse, for a daemon that runs
 * unless told not to (dnsmasq): its s6 run script waits while the file
 * exists, and its systemd unit carries `ConditionPathExists=!` on it, so it
 * is cleared before systemctl is asked (a start the condition skips still
 * returns success) and set by stop() under either supervisor.
 */
export function createUnitControl({
  unit,
  processName,
  pidFile = null,
  restartPendingFile,
  enableFile = null,
  disableFile = null,
}) {
  function writeFlag(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
  }

  function setEnabled(enabled) {
    if (enableFile) {
      if (enabled) writeFlag(enableFile);
      else fs.rmSync(enableFile, { force: true });
    }
    if (disableFile) {
      if (enabled) fs.rmSync(disableFile, { force: true });
      else writeFlag(disableFile);
    }
  }

  const tell = (action, error = null) => emitUnitEvent(action, { unit, processName, error });

  function setRestartPending(pending) {
    try {
      if (pending) {
        fs.mkdirSync(path.dirname(restartPendingFile), { recursive: true });
        fs.writeFileSync(restartPendingFile, new Date().toISOString());
      } else {
        fs.rmSync(restartPendingFile, { force: true });
      }
    } catch {
      /* marker is best-effort */
    }
  }

  // Is the unit installed here? An install that left dnsmasq to the host
  // (install.sh's include or skip mode) has no cidrella-dnsmasq.service, and
  // CIDRella cannot stop a daemon it does not run. Without systemctl, s6
  // runs every daemon in the container.
  function installed() {
    try {
      const state = execFileSync('systemctl', ['show', '-p', 'LoadState', '--value', unit], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return state.toString().trim() === 'loaded';
    } catch (err) {
      return err?.code === 'ENOENT';
    }
  }

  // Under systemd, ask about the exact unit: another process of the same
  // name on the host (libvirt's dnsmasq, a distribution Kea) must not count.
  // Without systemctl the only one in the container is ours.
  function isRunning() {
    try {
      execFileSync('systemctl', ['is-active', '--quiet', unit], { stdio: 'ignore' });
      return true;
    } catch (err) {
      if (err?.code !== 'ENOENT') return false;
    }
    try {
      execFileSync('pidof', [processName], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  const restartPending = () => fs.existsSync(restartPendingFile);

  function reload() {
    try {
      execFileSync('systemctl', ['reload', unit], { stdio: 'pipe' });
      return;
    } catch (err) {
      const stderr = stderrOf(err);
      if (stderr) console.warn(`systemctl reload ${unit} failed:`, stderr);
    }
    try {
      if (pidFile) {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
        if (pid) process.kill(pid, 'SIGHUP');
      } else {
        execFileSync('pkill', ['-HUP', '-x', processName], { stdio: 'pipe' });
      }
    } catch {
      console.warn(`Could not send SIGHUP to ${processName} (may not be running)`);
    }
  }

  function restart() {
    try {
      // Before systemctl: the unit's start condition reads it.
      if (disableFile) fs.rmSync(disableFile, { force: true });
    } catch (err) {
      console.warn(`Could not enable ${processName}:`, err.message);
      setRestartPending(true);
      tell('restart_failed', err.message);
      return;
    }
    try {
      execFileSync('systemctl', ['restart', unit], { stdio: 'pipe' });
      console.log(`${processName} restarted via systemctl`);
      setRestartPending(false);
      tell('restarted');
      return;
    } catch (err) {
      const stderr = stderrOf(err);
      if (stderr) console.warn(`systemctl restart ${unit} failed:`, stderr);
    }
    // Terminate and let the supervisor start it again.
    try {
      setEnabled(true);
    } catch (err) {
      console.warn(`Could not enable ${processName}:`, err.message);
      setRestartPending(true);
      tell('restart_failed', err.message);
      return;
    }
    try {
      execFileSync('pkill', ['-TERM', '-x', processName], { stdio: 'pipe' });
      console.log(`${processName} terminated (supervisor will restart)`);
      setRestartPending(false);
      tell('restarted');
    } catch {
      if (enableFile || disableFile) {
        // Not running yet: its run script starts it once the flag allows.
        setRestartPending(false);
        tell('restarted');
        return;
      }
      console.warn(`Could not restart ${processName}`);
      setRestartPending(true);
      tell('restart_failed', 'not running, and no supervisor flag to start it');
    }
  }

  // Stop the daemon: a backend that no longer fills any role. Without
  // systemctl a TERM stops it until the supervisor starts it again, which
  // s6 does unless the service waits on its flag. Returns once asked, not
  // once stopped: awaitStopped() waits for that.
  function stop() {
    try {
      setEnabled(false);
    } catch {
      /* gone already */
    }
    try {
      execFileSync('systemctl', ['stop', unit], { stdio: 'pipe' });
      tell('stopped');
      return;
    } catch (err) {
      // Under systemd a TERM would only see the unit restarted, and could
      // reach a daemon of the same name that is not ours (libvirt's dnsmasq).
      if (err?.code !== 'ENOENT') {
        const stderr = stderrOf(err);
        if (stderr) console.warn(`systemctl stop ${unit} failed:`, stderr);
        return;
      }
    }
    try {
      execFileSync('pkill', ['-TERM', '-x', processName], { stdio: 'pipe' });
      tell('stopped');
    } catch {
      /* not running */
    }
  }

  // Wait until the daemon has exited, so another one can take its ports.
  async function awaitStopped({ timeoutMs = 10000, intervalMs = 200 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (isRunning()) {
      if (Date.now() >= deadline) {
        throw new Error(`${processName} is still running ${timeoutMs / 1000} s after it was stopped`);
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  return { isRunning, installed, restartPending, reload, restart, stop, awaitStopped };
}
