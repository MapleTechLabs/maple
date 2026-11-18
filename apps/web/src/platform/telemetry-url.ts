import { Array as Arr, String as Str } from "effect"

/**
 * A URL as Maple's own telemetry keeps it: origin and first path segment only. Every dashboard
 * path past that (a service, a trace id) and every query (filters, search text) is customer data.
 */
export const sanitizeSelfTelemetryUrl = (url: string): string => {
	if (!URL.canParse(url)) return "[url]"
	const parsed = new URL(url)
	const segments = Arr.filter(Str.split("/")(parsed.pathname), Str.isNonEmpty)
	const [first] = segments
	const path = first === undefined ? "/" : `/${first}${segments.length > 1 ? "/:path" : ""}`
	return `${parsed.origin}${path}`
}
