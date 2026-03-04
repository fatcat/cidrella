import axios from 'axios';
import { useAuthStore } from '../stores/auth.js';
import router from '../router/index.js';

const api = axios.create({
  baseURL: '/api'
});

// Attach JWT token to requests
api.interceptors.request.use(config => {
  const auth = useAuthStore();
  if (auth.token) {
    config.headers.Authorization = `Bearer ${auth.token}`;
  }
  return config;
});

// Handle 401 responses
api.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 401) {
      const auth = useAuthStore();
      auth.logout();
      router.push('/login');
    }
    return Promise.reject(error);
  }
);

export default api;
