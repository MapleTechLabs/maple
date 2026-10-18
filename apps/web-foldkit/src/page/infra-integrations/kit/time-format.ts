import { EMPTY_VALUE } from "@maple/ui/lib/format"

// `formatTimeInTimezone` (apps/web/src/lib/timezone-format.ts): "02:15 PM" in the viewer's zone.
// The page context's zone is already resolved, so the browser-zone fallback is not repeated here.

/** An epoch, or an ISO / warehouse (`YYYY-MM-DD HH:MM:SS`, UTC) timestamp. */
export const formatTimeInTimezone = (input: number | string, timeZone: string): string => {
	const date = new Date(
		typeof input === "string" && /^\d{4}-\d{2}-\d{2} \d/.test(input)
			? `${input.replace(" ", "T")}Z`
			: input,
	)
	if (Number.isNaN(date.getTime())) return EMPTY_VALUE
	return new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit" }).format(date)
}
