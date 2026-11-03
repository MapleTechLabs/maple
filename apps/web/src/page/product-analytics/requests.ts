import { Option } from "effect"
import { Command } from "foldkit"
import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import { previousWindow } from "../../components/analytics/previous-window"
import type { TimeWindow } from "../../data/time-range"
import type { Resources } from "../../platform/resources"
import type { PageContext } from "../contract"
import { FetchBreakdowns, FetchEventNames, FetchFunnel, FetchPaths } from "./command"
import { funnelParamsOf, pathsParamsOf, populationOf, tabOf } from "./definition"
import type { Message, SlotName } from "./message"
import type { Model } from "./model"

// The reads the page makes, each keyed by its input: the rail's options always, then the tab's own.

type Cmd = Command.Command<Message, never, Resources>

const BREAKDOWN_LIMIT = 50
export const EVENTS_LIMIT = 200

type Request = Readonly<{ slot: SlotName; fn: string; input: object; command: (key: string) => Cmd }>

const plan = (model: Model, window: TimeWindow): ReadonlyArray<Request> => {
	const population = populationOf(model.search)
	const { startTime, endTime } = window
	const breakdownsInput = { startTime, endTime, limitPerDimension: BREAKDOWN_LIMIT, ...population }
	const events = (slot: SlotName, range: TimeWindow): Request => {
		// One past the limit, so a full answer can tell "exactly 200" from "more than 200".
		const input = { ...range, limit: EVENTS_LIMIT + 1, ...population }
		return {
			slot,
			fn: "getProductEventNames",
			input,
			command: (key) => FetchEventNames({ slot, key, input }),
		}
	}
	const rail: Request = {
		slot: "breakdowns",
		fn: "getWebAnalyticsBreakdowns",
		input: breakdownsInput,
		command: (key) => FetchBreakdowns({ slot: "breakdowns", key, input: breakdownsInput }),
	}
	switch (tabOf(model.search)) {
		case "events":
			return [
				rail,
				events("events", window),
				events("previousEvents", previousWindow(startTime, endTime)),
			]
		case "funnels": {
			const params = funnelParamsOf(model.search)
			const input = params === null ? null : { startTime, endTime, ...params }
			return [
				rail,
				events("events", window),
				...(input === null
					? []
					: [
							{
								slot: "funnel" as const,
								fn: "getProductEventsFunnelWidget",
								input,
								command: (key: string) => FetchFunnel({ slot: "funnel", key, input }),
							},
						]),
			]
		}
		case "paths": {
			const params = pathsParamsOf(model.search)
			const input = params === null ? null : { startTime, endTime, ...params }
			return [
				rail,
				events("events", window),
				...(input === null
					? []
					: [
							{
								slot: "paths" as const,
								fn: "getProductEventsPathsWidget",
								input,
								command: (key: string) => FetchPaths({ slot: "paths", key, input }),
							},
						]),
			]
		}
	}
}

/** Requests every slot the tab reads; a slot whose key held (and that answered) stays put. */
export const requestSlots = (
	model: Model,
	context: PageContext,
	window: TimeWindow,
	mode: Keyed.RequestMode,
	only?: ReadonlyArray<SlotName>,
): { readonly model: Model; readonly commands: ReadonlyArray<Cmd> } =>
	plan(model, window)
		.filter((request) => only === undefined || only.includes(request.slot))
		.reduce<{ model: Model; commands: ReadonlyArray<Cmd> }>(
			(state, request) => {
				const key = requestKey(context.orgId, request.fn, { data: request.input })
				const current: Keyed.Keyed<unknown, unknown> = state.model[request.slot]
				return Option.match(Keyed.request(current, key, mode), {
					onNone: () => state,
					onSome: (slot) => ({
						model: { ...state.model, [request.slot]: slot },
						commands: [...state.commands, request.command(key)],
					}),
				})
			},
			{ model, commands: [] },
		)
