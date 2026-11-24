// `maple sourcemaps inject|upload`: the inject core is shared with the Alchemy Vite plugin.
import { SOURCE_MAP_MAX_BYTES } from "@maple/domain/http"

export * from "@maple/sourcemaps"

/** Maps above this are refused by the server (the largest it can symbolicate with), so they are skipped before the upload. */
export const MAX_MAP_BYTES = SOURCE_MAP_MAX_BYTES
