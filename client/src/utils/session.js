// Why the last session ended, carried from the moment it ended to the
// sign-in page in sessionStorage, which outlives the redirect but not the tab.
const SIGNED_OUT_KEY = 'cidrella_signed_out';

/** The reasons the server sends with a SESSION_ENDED 401 (models/session.js). */
const MESSAGES = {
  idle: (minutes) =>
    minutes
      ? `Signed out after ${minutes} minutes without activity.`
      : 'Signed out for inactivity.',
  expired: () => 'Your session reached its 24 hour limit. Sign in again.',
  password_changed: () => 'Your password was changed. Sign in with the new one.',
  password_reset: () => 'An administrator reset your password. Sign in with the new one.',
  role_changed: () => 'Your role was changed. Sign in again to pick it up.',
  user_deleted: () => 'Your account was removed.',
  logout: () => 'You signed out in another tab.',
  revoked: () => 'Your session was ended. Sign in again.',
  restore: () => 'A backup was restored. Sign in again.',
};

export function rememberSignOut(reason, idleTimeoutSeconds = null) {
  try {
    sessionStorage.setItem(
      SIGNED_OUT_KEY,
      JSON.stringify({
        reason,
        minutes: idleTimeoutSeconds ? Math.round(idleTimeoutSeconds / 60) : null,
      }),
    );
  } catch {
    /* storage blocked: the sign-in page just shows no reason */
  }
}

/** The sign-in page's one-time line about why it is showing, or null. */
export function takeSignOutMessage() {
  let saved;
  try {
    saved = JSON.parse(sessionStorage.getItem(SIGNED_OUT_KEY) || 'null');
    sessionStorage.removeItem(SIGNED_OUT_KEY);
  } catch {
    return null;
  }
  if (!saved) return null;
  const message = MESSAGES[saved.reason];
  return message ? message(saved.minutes) : 'Your session ended. Sign in again.';
}
