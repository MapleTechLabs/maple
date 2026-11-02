import { FetchSpanDetail, FetchSpanLogs } from "@maple/views/traces/span-panel/command"
import { AsyncData } from "foldkit"
import { type Lane, outcomeOf, slotLane } from "../../data/lanes"
import { FetchTrace } from "./command"
import type { Model } from "./model"

const isInFlight = (data: AsyncData.AsyncData<unknown, unknown>) => AsyncData.isLoading(data) || AsyncData.isRefreshing(data)

/** The requests this page may have in flight (see `data/lanes.ts`): the trace and the open span's. */
export const lanes = (model: Model): ReadonlyArray<Lane> => {
	const panel = model.panel
	const panelLanes = (panel === null ? [] : [
		{ scope: FetchSpanDetail.name, read: panel.detail, stop: (key: string) => FetchSpanDetail.Interrupt({ key }, outcomeOf) },
		{ scope: FetchSpanLogs.name, read: panel.logs, stop: (key: string) => FetchSpanLogs.Interrupt({ key }, outcomeOf) },
	]).flatMap(({ scope, read, stop }): ReadonlyArray<Lane> => {
		const { key } = read
		return key === null ? [] : [{ scope, key, isInFlight: isInFlight(read.data), stop: () => stop(key) }]
	})
	return [...slotLane(FetchTrace.name, model.trace, (key) => FetchTrace.Interrupt({ key }, outcomeOf)), ...panelLanes]
}
