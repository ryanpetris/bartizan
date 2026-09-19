/** A symmetric seven-pixel creature, with a solid face and two open eyes. */
export function identiconCells(seed: string): [number, number][] {
  let hash = 2166136261;
  for (const character of seed) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  // Mix the high bits down so nearby profile IDs produce different silhouettes.
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  hash ^= hash >>> 16;
  const cells: [number, number][] = [];
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 4; x++) {
      if (y === 3 && x === 2) continue;
      const face = y >= 2 && y <= 4 && x >= 1;
      if (!face && !(hash & (1 << (y * 4 + x)))) continue;
      cells.push([x, y]);
      if (x !== 3) cells.push([6 - x, y]);
    }
  }
  return cells;
}

export function Identicon({ seed }: { seed: string }) {
  return (
    <svg className="identicon" viewBox="0 0 9 9" fill="currentColor" aria-hidden="true" focusable="false">
      {identiconCells(seed).map(([x, y]) => (
        <rect key={`${x},${y}`} x={x + 1.075} y={y + 1.075} width="0.85" height="0.85" rx="0.15" />
      ))}
    </svg>
  );
}
