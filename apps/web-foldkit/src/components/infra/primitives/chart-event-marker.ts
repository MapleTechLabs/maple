import type { Tone } from "@maple/ui/lib/tone"

// The marker type alone, so modules like worker-signals.ts can name it without the chart.

export type ChartEventTone = Extract<Tone, "neutral" | "warn" | "crit">

export interface ChartEventMarker {
	readonly id: string
	/** ISO timestamp of the event. */
	readonly at: string
	readonly label: string
	readonly tone: ChartEventTone
	/** When present the marker is drawn as a band rather than a line. */
	readonly endsAt?: string
}
