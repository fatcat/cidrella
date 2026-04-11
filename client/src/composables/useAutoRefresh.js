import { onMounted, onUnmounted } from 'vue';

export function useAutoRefresh(fn, interval = 60000) {
  let timer = null;
  onMounted(() => { timer = setInterval(fn, interval); });
  onUnmounted(() => { if (timer) clearInterval(timer); });
}
