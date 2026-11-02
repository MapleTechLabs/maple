/** Approximate byte size of an event for flush-threshold accounting. Falls back
 *  to a fixed estimate for values that can't be serialized (e.g. cycles). */
export function approximateSize(value: unknown): number {
	try {
		// oxlint-disable-next-line effecttsgo/global-json -- customer-facing SDK, keeps Schema out of the bundle
		return JSON.stringify(value).length
	} catch {
		return 256
	}
}
