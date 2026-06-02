// tools/calibrators/_family-a-rng.ts
//
// Deterministic RNG helpers extracted verbatim from family-a.ts so the
// betting-bootstrap decomposition helpers can share them. No behavior
// altered.

/** Mulberry32 deterministic uniform RNG. Inlined here for self-
 *  containment relative to dist/ layout (matches family-c.ts pattern). */
export function mulberry32Local(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function standardNormalLocal(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
