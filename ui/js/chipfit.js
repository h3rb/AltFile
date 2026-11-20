export function visibleChips(defs, counts, activeId) {
  return defs.filter(
    (def) => def.id === 'all' || def.smart || def.id === activeId || (counts.get(def.id) || 0) > 0,
  );
}
