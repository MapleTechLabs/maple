import { Effect, Schema } from "effect"
import { readEffectiveTimeZone } from "../platform/time-zone"

/** What a lab logs view reads from the browser before it renders: the display zone and number locale. */
export const ViewerFlags = Schema.Struct({ timeZone: Schema.String, locale: Schema.String })
export type ViewerFlags = typeof ViewerFlags.Type

export const viewerFlags: Effect.Effect<ViewerFlags> = Effect.map(readEffectiveTimeZone, (timeZone) => ({
	timeZone,
	locale: navigator.language,
}))
