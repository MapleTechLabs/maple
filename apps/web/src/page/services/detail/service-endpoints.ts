/**
 * The warehouse caps the list by traffic before the browser classifies probes and unrouted
 * paths, so a service of raw URL paths can spend the whole budget on rows that collapse. Fixing
 * that needs an `http.route` discriminator in the rollup, not a bigger number here. It is 200,
 * not the Operations tab's 25, because this tab draws no sparklines.
 */
export const ENDPOINTS_LIMIT = 200

/** The warehouse returned a full page, so there are probably more endpoints. */
export function isTruncated(returned: number): boolean {
	return returned >= ENDPOINTS_LIMIT
}
