import { Effect } from "effect"

/** The locale a page formats with until the browser's language has been read. */
export const INITIAL_LOCALE = "en-US"

/** `toLocaleString()`'s implicit locale, read in a Command so views stay pure. */
export const readLocale: Effect.Effect<string> = Effect.sync(() => navigator.language)

/** An exact count for a tooltip or title, where cells show the compact `formatNumber`. Without a
 *  locale it groups digits the viewer's way, as `toLocaleString()` does. */
export const formatExactCount = (value: number, locale?: string): string =>
	value.toLocaleString(locale, { maximumFractionDigits: 0 })
