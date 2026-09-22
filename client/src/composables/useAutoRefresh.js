import { onMounted, onUnmounted } from 'vue';

// Re-run `fn` every `interval` ms while the page is mounted. A hidden tab
// skips the tick: nobody is reading it, and the next visible tick catches up.
export function useAutoRefresh(fn, interval = 60000) {
  let timer = null;
  onMounted(() => {
    timer = setInterval(() => {
      if (globalThis.document?.hidden) return;
      fn();
    }, interval);
  });
  onUnmounted(() => {
    if (timer) clearInterval(timer);
  });
}
