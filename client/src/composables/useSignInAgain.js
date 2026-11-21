import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth.js';
import { useFeaturesStore } from '../stores/features.js';

/**
 * Leave for the sign-in page after this box changed what it is (joined a
 * controller, was promoted): the session here is forgotten, the features are
 * read again at the next sign-in, and the sign-in page says why (`reason` and
 * `detail` as utils/session.js takes them).
 */
export function useSignInAgain() {
  const router = useRouter();
  const auth = useAuthStore();
  const features = useFeaturesStore();
  return function signInAgain(reason, detail = null) {
    auth.logout(reason, detail);
    features.reset();
    return router.push({ name: 'Login' });
  };
}
