import axios from 'axios';
import { useDebugStore } from '../stores/debug.js';
import { endedReason } from '../utils/session.js';

const api = axios.create({
  baseURL: '/api',
});

// The session this client speaks for, registered by main.js at boot. The
// client imports neither the auth store nor the router: both import the
// client, and the loop would leave whichever module loads second reading a
// binding that is not initialized yet.
let session = { token: () => null, onUnauthorized: () => {} };

/**
 * Tell the client where the sign-in token comes from, and what to do when the
 * server says the session holding it has ended (`reason` as rememberSignOut
 * takes it).
 */
export function configureApi({ token, onUnauthorized }) {
  session = { token, onUnauthorized };
}

// Attach JWT token to requests
api.interceptors.request.use((config) => {
  const token = session.token();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Log API calls and handle 401 responses
api.interceptors.response.use(
  (response) => {
    try {
      const debug = useDebugStore();
      debug.logApi(
        `${response.config?.method?.toUpperCase()} ${response.config?.url} → ${response.status}`,
      );
    } catch {
      /* store may not be ready */
    }
    return response;
  },
  (error) => {
    try {
      const debug = useDebugStore();
      const status = error.response?.status || 'NETWORK';
      const msg = error.response?.data?.error || error.message;
      debug.logError(
        `${error.config?.method?.toUpperCase()} ${error.config?.url} → ${status}`,
        msg,
      );
    } catch {
      /* store may not be ready */
    }
    if (error.response?.status === 401 && !error.config?.url?.includes('/auth/login')) {
      // Only a 401 for the token this browser holds now ends anything. A poll
      // still in flight when the user signed out, or sent before they signed
      // in again, answers for a session that is already gone.
      const token = session.token();
      const sentWith = error.config?.headers?.Authorization;
      if (token && sentWith === `Bearer ${token}`) {
        // The server says why the session ended; the sign-in page repeats it.
        session.onUnauthorized(endedReason(error.response.data));
      }
    }
    return Promise.reject(error);
  },
);

export default api;
