import { type Lane, outcomeOf, slotLane } from "../../data/lanes"
import { FetchByType, FetchFacets, FetchSummary, FetchTraces } from "./command"
import type { Model } from "./model"

/** The requests this page may have in flight (see `data/lanes.ts`), each expanded card's traces too. */
export const lanes = (model: Model): ReadonlyArray<Lane> => [
	...slotLane(FetchSummary.name, model.summary, (key) => FetchSummary.Interrupt({ key }, outcomeOf)),
	...slotLane(FetchByType.name, model.byType, (key) => FetchByType.Interrupt({ key }, outcomeOf)),
	...slotLane(FetchFacets.name, model.facets, (key) => FetchFacets.Interrupt({ key }, outcomeOf)),
	...Object.values(model.cards).flatMap((card) =>
		slotLane(FetchTraces.name, card.traces, (key) => FetchTraces.Interrupt({ key }, outcomeOf)),
	),
]
