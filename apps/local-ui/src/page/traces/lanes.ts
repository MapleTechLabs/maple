import { type Lane, outcomeOf, slotLane } from "../../data/lanes"
import { FetchFacets, FetchNextPage, FetchTraces } from "./command"
import type { Model } from "./model"

/** The requests this page may have in flight (see `data/lanes.ts`). */
export const lanes = (model: Model): ReadonlyArray<Lane> => [
	...slotLane(FetchTraces.name, model.traces, (key) => FetchTraces.Interrupt({ key }, outcomeOf)),
	...slotLane(FetchFacets.name, model.facets, (key) => FetchFacets.Interrupt({ key }, outcomeOf)),
	...(model.traces.key === null
		? []
		: [nextPageLane(model.traces.key, model.pageGeneration, model.isFetchingNextPage)]),
]

/** The next page in flight: one per list generation, retired by a reload or a new key. */
const nextPageLane = (key: string, generation: number, isInFlight: boolean): Lane => ({
	scope: FetchNextPage.name,
	key: `${key}#${generation}`,
	isInFlight,
	stop: () => FetchNextPage.Interrupt({ key, generation }, outcomeOf),
})
