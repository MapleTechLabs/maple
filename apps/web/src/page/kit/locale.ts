import { Effect } from "effect"

/** The locale a page formats with until the browser's language has been read. */
export const INITIAL_LOCALE = "en-US"

/** `toLocaleString()`'s implicit locale, read in a Command so views stay pure. */
export const readLocale: Effect.Effect<string> = Effect.sync(() => navigator.language)
