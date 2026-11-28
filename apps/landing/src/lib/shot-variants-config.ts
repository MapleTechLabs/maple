/** Shared by `scripts/shot-variants.ts`, which writes the copies, and `shot-sources.ts`, which lists them. */
export const SHOT_VARIANT_WIDTHS = [960, 1440] as const
/** Under `public/screenshots/`. Generated, not committed. */
export const SHOT_VARIANT_DIR = "w"
/** Relative to the landing app. */
export const SHOT_VARIANTS_MANIFEST = "node_modules/.cache/shot-variants.json"
