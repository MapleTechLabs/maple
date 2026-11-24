/**
 * Largest source map one upload may carry: also the largest symbolication loads, so an upload that
 * succeeds can always be used. Kept apart from the inject code so browser bundles can import it.
 */
export const SOURCE_MAP_MAX_BYTES = 10 * 1024 * 1024
