/**
 * Difficulty metadata shared by the app (for copy) and the AI worker.
 * Keeping the numbers here lets the main thread load the lobby without
 * constructing the AI's search tables.
 */
export const AI_LEVELS = {
  easy: {
    key: 'easy',
    label: '轻松',
    tagline: '会看眼前，但偶尔走神',
    depths: [],
    timeLimit: 80,
    rootPlace: 8,
    rootSlice: 1,
    innerPlace: 6,
    innerSlice: 1,
  },
  normal: {
    key: 'normal',
    label: '标准',
    tagline: '会抢胜点，也会封你的四连',
    depths: [2],
    timeLimit: 700,
    rootPlace: 14,
    rootSlice: 4,
    innerPlace: 8,
    innerSlice: 2,
  },
  hard: {
    key: 'hard',
    label: '困难',
    tagline: '预演三步，寻找跨切面的杀招',
    depths: [2, 3],
    timeLimit: 1000,
    rootPlace: 18,
    rootSlice: 6,
    innerPlace: 9,
    innerSlice: 2,
  },
};

export function difficultyName(key) {
  return AI_LEVELS[key]?.label ?? AI_LEVELS.normal.label;
}
