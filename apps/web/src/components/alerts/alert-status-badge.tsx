import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { TONE_TEXT, type Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"

export type AlertStatusState =
	| "firing"
	| "ok"
	| "disabled"
	| "resolved"
	| "pending"
	| "error"
	| "stale"
	| "no-data"
	| "held"

const toneByState: Record<AlertStatusState, { tone: Tone; strong?: boolean; label: string }> = {
	firing: { tone: "crit", strong: true, label: "Firing" },
	ok: { tone: "ok", label: "OK" },
	disabled: { tone: "neutral", label: "Disabled" },
	resolved: { tone: "ok", label: "Resolved" },
	pending: { tone: "warn", label: "Pending" },
	error: { tone: "warn", strong: true, label: "Error" },
	stale: { tone: "warn", label: "Stale" },
	"no-data": { tone: "neutral", label: "No data" },
	// An open incident whose breach stopped appearing while its telemetry could
	// not be proven live: neither firing nor resolved until data returns or the
	// hold ceiling elapses.
	held: { tone: "warn", label: "Waiting on data" },
} satisfies Record<AlertStatusState, { tone: Tone; strong?: boolean; label: string }>

export function AlertStatusBadge({
	state,
	label,
	className,
}: {
	state: AlertStatusState
	label?: string
	className?: string
}) {
	const tone = toneByState[state]
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1.5 text-xs",
				TONE_TEXT[tone.tone],
				tone.strong && "font-medium",
				className,
			)}
		>
			<StatusDot tone={tone.tone} />
			<span>{label ?? tone.label}</span>
		</span>
	)
}
