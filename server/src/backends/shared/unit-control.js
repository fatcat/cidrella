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

const stderrOf = (err) => err?.stderr?.toString?.().trim();

/**
 * `unit` is the systemd unit, `processName` the executable s6 runs, and
 * `pidFile` (optional) where the daemon writes its pid, for a reload signal
 * aimed at one process rather than every process of that name.
 *
 * `enableFile` (optional) is for a daemon s6 keeps down until it is wanted
 * (Kea, which runs only while it serves DHCP): its run script waits for the
 * file. Without systemctl, restart writes it and stop removes it.
 */
export function createUnitControl({
  unit,
  processName,
  pidFile = null,
  restartPendingFile,
  enableFile = null,
}) {
  function setEnabled(enabled) {
    if (!enableFile) return;
    if (enabled) {
      fs.mkdirSync(path.dirname(enableFile), { recursive: true });
      fs.writeFileSync(enableFile, '');
    } else {
      fs.rmSync(enableFile, { force: true });
    }
  }

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
      execFileSync('systemctl', ['restart', unit], { stdio: 'pipe' });
      console.log(`${processName} restarted via systemctl`);
      setRestartPending(false);
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
      return;
    }
    try {
      execFileSync('pkill', ['-TERM', '-x', processName], { stdio: 'pipe' });
      console.log(`${processName} terminated (supervisor will restart)`);
      setRestartPending(false);
    } catch {
      if (enableFile) {
        // Not running yet: its run script starts it on seeing the file.
        setRestartPending(false);
        return;
      }
      console.warn(`Could not restart ${processName}`);
      setRestartPending(true);
    }
  }

  // Stop the daemon: a backend that no longer fills any role. Without
  // systemctl a TERM stops it until the supervisor starts it again, which
  // s6 does unless the service waits on `enableFile`.
  function stop() {
    try {
      setEnabled(false);
    } catch {
      /* gone already */
    }
    try {
      execFileSync('systemctl', ['stop', unit], { stdio: 'pipe' });
      return;
    } catch (err) {
      const stderr = stderrOf(err);
      if (stderr) console.warn(`systemctl stop ${unit} failed:`, stderr);
    }
    try {
      execFileSync('pkill', ['-TERM', '-x', processName], { stdio: 'pipe' });
    } catch {
      /* not running */
    }
  }

  return { isRunning, restartPending, reload, restart, stop };
}
