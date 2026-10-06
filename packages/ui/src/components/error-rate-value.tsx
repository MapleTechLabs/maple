import { formatErrorRate } from "../lib/format"
import { ERROR_RATE_TEXT, errorRateLevel } from "../lib/error-rate"
import { cn } from "../lib/utils"

/** An error rate (0..1), formatted and toned by the shared thresholds in lib/error-rate.ts. */
export function ErrorRateValue({
	rate,
	format = formatErrorRate,
	className,
}: {
	rate: number
	format?: (rate: number) => string
	className?: string
}) {
	return (
		<span className={cn("font-mono tabular-nums", ERROR_RATE_TEXT[errorRateLevel(rate)], className)}>
			{format(rate)}
		</span>
	)
}
