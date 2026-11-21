export function spanRect(x0, y0, x1, y1) {
  return {
    left: Math.min(x0, x1),
    top: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
}

export function rectsIntersect(a, b) {
  return (
    a.left <= b.left + b.width &&
    b.left <= a.left + a.width &&
    a.top <= b.top + b.height &&
    b.top <= a.top + a.height
  );
}

export function marqueeSelection(hits, base, additive) {
  if (!additive) return new Set(hits);
  return new Set([...base, ...hits]);
}
