// Model-based test of the Networks workspace. Seeded random walks click
// through the workspace the way a person might, and after every step check
// what the screen shows against the fake estate (harness.js has the
// invariants, driver.js the actions). A failure prints the actions that got
// there; replay them with `walk([...])` in regressions.test.js.
//
// MODEL_SEEDS, MODEL_FIRST_SEED and MODEL_STEPS widen a local hunt:
//   MODEL_SEEDS=500 MODEL_STEPS=40 npx vitest run tests/unit/views/networks-workspace/model
import { describe, it, vi } from 'vitest';
import { useModelSession } from './session.js';

vi.mock('../../../../../src/api/client.js', () => ({
  default: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn(), patch: vi.fn() },
}));
vi.mock('../../../../../src/ui/useToast.js', () => ({ useToast: () => ({ add: vi.fn() }) }));
vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal()),
  useRouter: () => ({ push: vi.fn(), currentRoute: { value: { fullPath: '/networks' } } }),
}));

const FIRST = Number(process.env.MODEL_FIRST_SEED || 1);
const SEEDS = Number(process.env.MODEL_SEEDS || 12);
const STEPS = Number(process.env.MODEL_STEPS || 25);

describe('Networks workspace model', () => {
  const { randomWalk } = useModelSession();
  for (let seed = FIRST; seed < FIRST + SEEDS; seed += 1) {
    it(`random walk ${seed}`, () => randomWalk(seed, STEPS), 120_000);
  }
});
