import axios from 'axios';
import { useAuthStore } from '../stores/auth.js';
import { useDebugStore } from '../stores/debug.js';
import router from '../router/index.js';

const api = axios.create({
  baseURL: '/api',
});

// Attach JWT token to requests
api.interceptors.request.use((config) => {
  const auth = useAuthStore();
  if (auth.token) {
    config.headers.Authorization = `Bearer ${auth.token}`;
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
      const auth = useAuthStore();
      const sentWith = error.config?.headers?.Authorization;
      if (auth.token && sentWith === `Bearer ${auth.token}`) {
        // The server says why the session ended; the sign-in page repeats it.
        const data = error.response.data || {};
        auth.logout(data.code === 'SESSION_ENDED' ? data.reason || 'revoked' : 'revoked');
        router.push('/login');
      }
    }
    return Promise.reject(error);
  },
);

export default api;
