/* global document -- these run in the test DOM. */
// The walk machinery both model test files share: a fresh estate and session
// per test, every step checked, and a reload at the end that must bring the
// same screen back. The test files keep their own vi.mock calls (vitest
// hoists those per file).
import { afterEach, beforeEach, expect, vi } from 'vitest';
import api from '../../../../../src/api/client.js';
import { createFakeApi } from './fake-estate.js';
import {
  freshSession,
  mountWorkspace,
  observe,
  postconditions,
  restorable,
  settle,
  violations,
} from './harness.js';
import { candidates, perform, random } from './driver.js';

export function useModelSession() {
  let fake;
  let errors;

  // A fresh browser and estate: per test, and per replay while shrinking.
  function reset() {
    document.body.innerHTML = '';
    localStorage.clear();
    fake = createFakeApi();
    api.get.mockImplementation((url, config) => fake.get(url, config));
    errors = [];
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    reset();
    const record = (...args) => errors.push(args.map(String).join(' ').split('\n')[0]);
    vi.spyOn(console, 'error').mockImplementation(record);
    vi.spyOn(console, 'warn').mockImplementation((...args) => {
      // The unstyled UI plugin has no theme; that one warning is the harness's.
      if (!String(args[0]).includes('$primevue')) record(...args);
    });
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function start() {
    const pinia = freshSession();
    const session = { pinia, wrapper: mountWorkspace(pinia), trace: [] };
    await settle();
    check(session);
    return session;
  }

  function check(session, label = null) {
    const state = observe();
    const found = [
      ...violations(state, { unexpected: fake.unexpected, errors }),
      ...(label ? postconditions(label, state) : []),
    ];
    if (found.length) {
      const trace = session.trace.map((label) => `  '${label}',`).join('\n');
      const error = new Error(`${found.join('\n')}\n\nafter:\n${trace || '  (mount)'}`);
      error.violation = found[0];
      throw error;
    }
  }

  async function step(session, label) {
    session.trace.push(label);
    await perform(session, label);
    check(session, label);
  }

  async function reloadKeeps(session) {
    const before = restorable(observe());
    await step(session, 'reload');
    try {
      expect(restorable(observe())).toEqual(before);
    } catch (error) {
      error.violation = 'reload changed the screen';
      error.message = `reload changed the screen after:\n${session.trace.join('\n')}\n${error.message}`;
      throw error;
    }
  }

  // Replays a sequence, checking every step, then checks a reload.
  async function walk(labels) {
    const session = await start();
    for (const label of labels) await step(session, label);
    await reloadKeeps(session);
    session.wrapper.unmount();
  }

  // The kind of failure, without the ids and counts that vary with the steps.
  const signature = (violation) => String(violation).replace(/[\d.:,[\]]+/g, '#');

  // Does this sequence fail the same way? A step a shorter sequence can no
  // longer take (its row or card is gone) is not that failure.
  async function fails(labels, violation) {
    reset();
    let session;
    try {
      session = await start();
      for (const label of labels) await step(session, label);
      await reloadKeeps(session);
      return false;
    } catch (error) {
      return Boolean(error.violation) && signature(error.violation) === signature(violation);
    } finally {
      session?.wrapper.unmount();
    }
  }

  // Removes chunks of the sequence, halving the chunk size, while it still
  // fails, so a failure reports the few steps that matter.
  async function shrink(labels, violation) {
    let current = labels;
    for (let size = Math.ceil(current.length / 2); size >= 1; size = Math.floor(size / 2)) {
      for (let start = 0; start < current.length;) {
        const shorter = [...current.slice(0, start), ...current.slice(start + size)];
        if (shorter.length && (await fails(shorter, violation))) current = shorter;
        else start += size;
      }
    }
    return current;
  }

  async function randomWalk(seed, steps) {
    const next = random(seed);
    const session = await start();
    try {
      for (let index = 0; index < steps; index += 1) {
        const options = candidates();
        await step(session, options[Math.floor(next() * options.length)]);
      }
      await reloadKeeps(session);
      session.wrapper.unmount();
    } catch (error) {
      const failing = [...session.trace];
      session.wrapper.unmount();
      if (!error.violation) throw error;
      const shortest = await shrink(failing, error.violation);
      reset();
      const replay = `walk([\n${shortest.map((label) => `  '${label}',`).join('\n')}\n])`;
      error.message = `${error.message.split('\n\nafter:')[0]}\n\nShortest replay:\n${replay}\n\nFull walk (seed ${seed}):\n${failing.join('\n')}`;
      throw error;
    }
  }

  return { walk, randomWalk };
}
