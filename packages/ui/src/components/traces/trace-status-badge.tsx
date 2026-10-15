import { Badge } from "../ui/badge"
import { httpStatusTone } from "../../lib/http"
import { TONE_SOFT } from "../../lib/tone"

/**
 * A trace row's status: the root's HTTP status code when it has one, toned by class
 * (3xx keeps its own blue so redirects stand apart from 2xx), else OK / Error.
 */
export function TraceStatusBadge({
	hasError,
	httpStatusCode,
}: {
	hasError: boolean
	httpStatusCode?: number | null
}) {
	if (httpStatusCode == null) {
		return (
			<Badge variant="secondary" className={TONE_SOFT[hasError ? "crit" : "ok"]}>
				{hasError ? "Error" : "OK"}
			</Badge>
		)
	}
	const tone = httpStatusTone(httpStatusCode)
	return (
		<Badge
			variant="secondary"
			className={
				tone !== "neutral"
					? TONE_SOFT[tone]
					: httpStatusCode >= 300
						? "bg-chart-p50/15 text-chart-p50"
						: TONE_SOFT.ok
			}
		>
			{httpStatusCode}
		</Badge>
	)
}
