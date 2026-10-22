import { type Lane, outcomeOf, slotLane } from "../../data/lanes"
import { FetchSpanDetail, FetchSpanLogs, FetchTrace } from "./command"
import type { Model } from "./model"

/** The requests this page may have in flight (see `data/lanes.ts`): the trace and the open span's. */
export const lanes = (model: Model): ReadonlyArray<Lane> => [
	...slotLane(FetchTrace.name, model.trace, (key) => FetchTrace.Interrupt({ key }, outcomeOf)),
	...(model.panel === null
		? []
		: [
				...slotLane(FetchSpanDetail.name, model.panel.detail, (key) =>
					FetchSpanDetail.Interrupt({ key }, outcomeOf),
				),
				...slotLane(FetchSpanLogs.name, model.panel.logs, (key) =>
					FetchSpanLogs.Interrupt({ key }, outcomeOf),
				),
			]),
]
