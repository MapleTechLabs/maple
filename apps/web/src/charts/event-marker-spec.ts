import { Schema } from "effect"

// The chart event markers as data (`ChartEventMarker`), light enough for the view bundle.

export const EventTone = Schema.Literals(["neutral", "warn", "crit"])
export type EventTone = typeof EventTone.Type

export const ChartEventMarker = Schema.Struct({
	id: Schema.String,
	at: Schema.String,
	label: Schema.String,
	tone: EventTone,
	endsAt: Schema.optionalKey(Schema.String),
})
export type ChartEventMarker = typeof ChartEventMarker.Type

/** Each tone's colour plus the label fill (`--muted-foreground`), as literals. */
export const MarkerColors = Schema.Struct({
	neutral: Schema.String,
	warn: Schema.String,
	crit: Schema.String,
	label: Schema.String,
})
export type MarkerColors = typeof MarkerColors.Type
