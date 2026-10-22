import { type Lane, outcomeOf, slotLane } from "../../data/lanes"
import { FetchLogs, FetchNextPage, FetchPatterns, FetchServices, FetchSeverities } from "./command"
import type { Model } from "./model"

/** The requests this page may have in flight (see `data/lanes.ts`). */
export const lanes = (model: Model): ReadonlyArray<Lane> => [
	...slotLane(FetchLogs.name, model.logs, (key) => FetchLogs.Interrupt({ key }, outcomeOf)),
	...slotLane(FetchPatterns.name, model.patterns, (key) => FetchPatterns.Interrupt({ key }, outcomeOf)),
	...slotLane(FetchServices.name, model.services, (key) => FetchServices.Interrupt({ key }, outcomeOf)),
	...slotLane(FetchSeverities.name, model.severities, (key) => FetchSeverities.Interrupt({ key }, outcomeOf)),
	...(model.logs.key === null ? [] : [nextPageLane(model.logs.key, model.pageGeneration, model.isFetchingNextPage)]),
]

/** The next page in flight: one per list generation, retired by a reload or a new key. */
const nextPageLane = (key: string, generation: number, isInFlight: boolean): Lane => ({
	scope: FetchNextPage.name,
	key: `${key}#${generation}`,
	isInFlight,
	stop: () => FetchNextPage.Interrupt({ key, generation }, outcomeOf),
})
