// test/mSPRT.test.ts — Addition #17 (ARCHITECT-REPLY-34 D1) rename marker.
//
// The canonical Family A Page-CUSUM test file is now
// `./page-cusum.test.ts`. This marker file stays in place for one PR
// cycle so external test-discovery tooling that hard-globs
// `mSPRT.test.*` reports the rename rather than silently seeing zero
// matching files. It intentionally does NOT re-import the new file —
// the test harness globs `test/*.test.js` directly and would
// double-register every Page-CUSUM test under both names.
//
// Removal ships with the REPLY-36 follow-up cleanup.
export {};
