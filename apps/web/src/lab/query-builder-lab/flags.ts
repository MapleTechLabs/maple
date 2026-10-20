import { createFormulaDraft, createQueryDraft } from "@maple/query-engine/query-builder"
import { Clock, Effect, Option, Schema } from "effect"
import { readEffectiveTimeZone } from "../../platform/time-zone"
import { type Flags, TimeSearch } from "./model"

/** The route's `TimeRangeSearchFields`, read once from the URL (a lab entry has no router). */
const SEARCH_KEYS = new Set(["startTime", "endTime", "timePreset"])
const decodeSearch = Schema.decodeUnknownOption(TimeSearch)

export const searchOf = (query: string): TimeSearch => {
	const present = [...new URLSearchParams(query)].filter(
		([key, value]) => SEARCH_KEYS.has(key) && value !== "",
	)
	return Option.getOrElse(decodeSearch(Object.fromEntries(present)), () => ({}))
}

/** The clock, zone, URL window and the first drafts (`createQueryDraft` draws random ids). */
export const flags: Effect.Effect<Flags> = Effect.all({
	nowMs: Clock.currentTimeMillis,
	timeZone: readEffectiveTimeZone,
	search: Effect.sync(() => searchOf(window.location.search)),
	queries: Effect.sync(() => [createQueryDraft(0), createQueryDraft(1)]),
	formulas: Effect.sync(() => [createFormulaDraft(0, ["A", "B"])]),
})
