import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spanRect, rectsIntersect, marqueeSelection } from '../ui/js/marquee.js';

test('spanRect normalizes drag direction', () => {
  assert.deepEqual(spanRect(10, 20, 4, 8), { left: 4, top: 8, width: 6, height: 12 });
  assert.deepEqual(spanRect(4, 8, 10, 20), { left: 4, top: 8, width: 6, height: 12 });
});

test('rectsIntersect covers overlap, edges, and separation', () => {
  const box = { left: 0, top: 0, width: 10, height: 10 };
  assert.equal(rectsIntersect(box, { left: 5, top: 5, width: 10, height: 10 }), true);
  assert.equal(rectsIntersect(box, { left: 10, top: 10, width: 5, height: 5 }), true);
  assert.equal(rectsIntersect(box, { left: 11, top: 0, width: 5, height: 5 }), false);
  assert.equal(rectsIntersect(box, { left: 0, top: -6, width: 5, height: 5 }), false);
});

test('marqueeSelection replaces or unions with the base', () => {
  assert.deepEqual([...marqueeSelection(['a', 'b'], new Set(['x']), false)], ['a', 'b']);
  assert.deepEqual([...marqueeSelection(['a', 'b'], new Set(['x']), true)], ['x', 'a', 'b']);
});
