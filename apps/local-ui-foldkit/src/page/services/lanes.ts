import { type Lane, outcomeOf, slotLane } from "../../data/lanes"
import { FetchCatalog } from "./command"
import type { Model } from "./model"

/** The requests this page may have in flight (see `data/lanes.ts`). */
export const lanes = (model: Model): ReadonlyArray<Lane> => [
	...slotLane(FetchCatalog.name, model.catalog, (key) => FetchCatalog.Interrupt({ key }, outcomeOf)),
	...slotLane(FetchCatalog.name, model.unfiltered, (key) => FetchCatalog.Interrupt({ key }, outcomeOf)),
]
