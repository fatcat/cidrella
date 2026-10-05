// A tab opened before a deploy or an update still names the old bundle's
// chunks, and the new build has removed them, so the next lazy view fails to
// load ("Failed to fetch dynamically imported module"). Vite reports that as
// a `vite:preloadError` event; reloading picks up the new index and its chunks.
//
// One reload per window of RELOAD_GUARD_MS: if the chunk is still missing
// after a fresh load, the error is real and is left to surface, rather than
// reloading forever.

export const RELOAD_KEY = 'cidrella_chunk_reload_at';
export const RELOAD_GUARD_MS = 10_000;

export function installStaleChunkReload(win = window, now = () => Date.now()) {
  win.addEventListener('vite:preloadError', (event) => {
    let last;
    try {
      last = Number(win.sessionStorage.getItem(RELOAD_KEY)) || 0;
    } catch {
      return; // no storage, no loop guard: let the error surface
    }
    if (now() - last < RELOAD_GUARD_MS) return;
    try {
      win.sessionStorage.setItem(RELOAD_KEY, String(now()));
    } catch {
      return;
    }
    event.preventDefault();
    win.location.reload();
  });
}
