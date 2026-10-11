// WebGL capability probe, injectable for tests.
export const isWebGLAvailable = (createCanvas: () => { getContext: (id: string) => unknown } | null = () =>
  (typeof document === 'undefined' ? null : document.createElement('canvas'))): boolean => {
  try {
    const c = createCanvas();
    if (!c) return false;
    return !!(c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl'));
  } catch {
    return false;
  }
};
