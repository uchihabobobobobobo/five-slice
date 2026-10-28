import { chooseAction } from './ai.js';

self.onmessage = (event) => {
  const { id, snapshot, difficulty, timeLimit } = event.data || {};
  try {
    const action = chooseAction(snapshot, { difficulty, timeLimit });
    self.postMessage({ id, action });
  } catch (error) {
    self.postMessage({ id, error: error?.message || 'AI error' });
  }
};
