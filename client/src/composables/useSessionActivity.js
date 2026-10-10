import { computed, onMounted, onUnmounted, ref } from 'vue';
import api from '../api/client.js';
import { useAuthStore } from '../stores/auth.js';

// Activity is a person using the page: these events, and a mouse move at most
// once a minute (a mouse bumped while reading still counts, a jiggle does not
// keep a session alive forever). API requests are never activity: the
// dashboards poll on timers.
const INPUT_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'];
const MOUSEMOVE_EVERY_MS = 60 * 1000;

// Input is reported to the server at most this often, by one tab for all.
export const REPORT_EVERY_MS = 60 * 1000;
// Other tabs hear about input at most this often.
const SHARE_INPUT_EVERY_MS = 5 * 1000;
export const IDLE_WARNING_MS = 60 * 1000;
export const EXPIRY_WARNING_MS = 5 * 60 * 1000;
// Past a deadline the client asks the server rather than deciding alone, so
// another tab's report or a slow clock never signs someone out early.
const DEADLINE_GRACE_MS = 2 * 1000;
const CHANNEL = 'cidrella-session';

/**
 * Keeps the signed-in session alive while a person uses CIDRella and warns
 * before it ends: 60 seconds before the inactivity limit, 5 minutes before
 * the 24 hour limit. The server decides; this reports input and counts down
 * to the deadlines the server sent (stores/auth.js applySessionTimes).
 */
export function useSessionActivity({ onSignedOut = () => {} } = {}) {
  const auth = useAuthStore();
  const now = ref(Date.now());
  const expiryDismissed = ref(false);

  let lastInput = 0;
  let lastReport = Date.now();
  let lastMove = 0;
  let lastShared = 0;
  let reporting = false;
  let checking = false;
  let timer = null;
  let channel = null;

  const idleSecondsLeft = computed(() => {
    const deadline = auth.session?.idleDeadline;
    return deadline == null ? null : Math.max(0, Math.ceil((deadline - now.value) / 1000));
  });
  const expirySecondsLeft = computed(() => {
    const at = auth.session?.expiresAt;
    return at == null ? null : Math.max(0, Math.ceil((at - now.value) / 1000));
  });
  const idleWarning = computed(
    () => idleSecondsLeft.value != null && idleSecondsLeft.value * 1000 <= IDLE_WARNING_MS,
  );
  const expiryWarning = computed(
    () =>
      !idleWarning.value &&
      !expiryDismissed.value &&
      expirySecondsLeft.value != null &&
      expirySecondsLeft.value * 1000 <= EXPIRY_WARNING_MS,
  );

  async function report() {
    if (reporting || !auth.token) return;
    reporting = true;
    lastReport = Date.now();
    try {
      const res = await api.post('/auth/activity');
      auth.applySessionTimes(res.data);
      channel?.postMessage({ type: 'times', times: res.data });
    } catch {
      /* a 401 signs out through the API client; anything else retries later */
    } finally {
      reporting = false;
    }
  }

  // Past a deadline: the server says whether the session really ended. A 401
  // signs out through the API client with the server's reason.
  async function check() {
    if (checking || !auth.token) return;
    checking = true;
    try {
      const res = await api.get('/auth/session');
      auth.applySessionTimes(res.data);
    } catch {
      /* handled by the API client */
    } finally {
      checking = false;
    }
  }

  function noteInput(at, { share = true } = {}) {
    if (at > lastInput) lastInput = at;
    if (share && at - lastShared >= SHARE_INPUT_EVERY_MS) {
      lastShared = at;
      channel?.postMessage({ type: 'input', at });
    }
    // Someone came back while the warning shows: tell the server now.
    if (idleWarning.value) report();
  }

  function onInput(event) {
    const at = Date.now();
    if (event.type === 'mousemove') {
      if (at - lastMove < MOUSEMOVE_EVERY_MS) return;
      lastMove = at;
    }
    noteInput(at);
  }

  function onMessage({ data }) {
    if (data?.type === 'input') noteInput(data.at, { share: false });
    if (data?.type === 'times') {
      // Another tab reported; this one need not.
      lastReport = Date.now();
      auth.applySessionTimes(data.times);
    }
  }

  function tick() {
    now.value = Date.now();
    if (!auth.session) return;
    if (lastInput > lastReport && now.value - lastReport >= REPORT_EVERY_MS) report();
    const { idleDeadline, expiresAt } = auth.session;
    const past = (deadline) => deadline != null && now.value >= deadline + DEADLINE_GRACE_MS;
    if (past(idleDeadline) || past(expiresAt)) check();
  }

  function stay() {
    report();
  }

  async function signOutNow() {
    await auth.signOut();
    onSignedOut();
  }

  function dismissExpiry() {
    expiryDismissed.value = true;
  }

  onMounted(() => {
    for (const type of [...INPUT_EVENTS, 'mousemove']) {
      window.addEventListener(type, onInput, { capture: true, passive: true });
    }
    if (typeof BroadcastChannel === 'function') {
      channel = new BroadcastChannel(CHANNEL);
      channel.addEventListener('message', onMessage);
    }
    timer = setInterval(tick, 1000);
  });

  onUnmounted(() => {
    for (const type of [...INPUT_EVENTS, 'mousemove']) {
      window.removeEventListener(type, onInput, { capture: true });
    }
    channel?.close();
    clearInterval(timer);
  });

  return {
    idleSecondsLeft,
    expirySecondsLeft,
    idleWarning,
    expiryWarning,
    stay,
    signOutNow,
    dismissExpiry,
  };
}
