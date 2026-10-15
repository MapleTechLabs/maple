import { formatCompactTimeInTimezone } from "@/lib/timezone-format"

/** `HH:MM:SS` at full strength, the milliseconds a step back: the eye reads seconds first. */
export function LogTime({ timestamp, timeZone }: { timestamp: string; timeZone: string }) {
	const formatted = formatCompactTimeInTimezone(timestamp, { timeZone })
	const dot = formatted.lastIndexOf(".")
	if (dot === -1) return formatted
	return (
		<>
			{formatted.slice(0, dot)}
			<span className="text-muted-foreground/50">{formatted.slice(dot)}</span>
		</>
	)
}
