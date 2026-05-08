// engine/types/families/b.ts — Family B (structural signatures).
//
// Family B ships its config inline on CompiledConfig.family_B (see
// config.ts) and carries no per-cell detector state — structural
// signatures fire on absolute-threshold ratios, not cumulative or
// baseline-relative statistics. This file is intentionally empty
// type-wise; it exists to mirror the Family A/C/D/E layout for
// future extension (e.g., Family B per-cell tunings for follow-on).

export {};
