import { toLoadFailure } from "@maple/views/data/load-failure"
import { Array as Arr, Effect, Option, Result, Schema } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { fromString } from "foldkit/url"
import {
	BreakdownInput,
	FetchCostBreakdown,
	FetchCostSources,
	FetchCostTimeseries,
	FetchCostTotals,
	ResolveWindow,
	TimeseriesInput,
	WindowInput,
} from "../page/cost/command"
import { Message as CostMessage } from "../page/cost/message"
import { Model as CostModel, type Search } from "../page/cost/model"
import * as Cost from "../page/cost/update"
import { view as costView } from "../page/cost/view"
import type { Resources } from "../platform/resources"
import { urlToAppRoute } from "../route"
import { LAB_NOW_MS, LAB_SOURCES, LAB_TODAY, labBreakdown, labTimeseries, labTotals } from "./cost-fixture"
import { LAB_CONTEXT } from "./gcp-host"
import { keepLocal } from "./local-commands"

// `/lab/cost`: the cost page, whole, over synthetic cost. Group by, sort, the row filters and the
// range all work: each read is answered from the fixture. `?state=` picks a start.

export const LabState = Schema.Literals([
	"populated",
	"filtered",
	"sources",
	"onramp",
	"pending",
	"error",
	"empty-window",
	"loading",
])
export type LabState = typeof LabState.Type

export const Flags = Schema.Struct({ state: LabState })
export type Flags = typeof Flags.Type

export const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	state: Option.getOrElse(
		Schema.decodeUnknownOption(LabState)(new URLSearchParams(window.location.search).get("state")),
		(): LabState => "populated",
	),
}))

export const Model = Schema.Struct({ state: LabState, cost: CostModel })
export type Model = typeof Model.Type

export const Message = defineMessageUnion({ GotCostMessage: { message: CostMessage } })
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message, Resources>
type CostCommand = Command.Command<CostMessage, never, Resources>

const searchFor = (state: LabState): Search =>
	state === "filtered" ? { groupBy: "region", cloud_service: ["Example Compute"] } : {}

/** The days a preset spans, for the fixture's window; a custom range reads as the default. */
const DAYS = new Map([
	["1w", 7],
	["2w", 14],
	["30d", 30],
	["3mo", 90],
	["6mo", 180],
	["12mo", 365],
])
const daysOf = (search: Search): number => DAYS.get(search.timePreset ?? Cost.DEFAULT_PRESET) ?? 30

const sourcesFor = (state: LabState) =>
	state === "onramp"
		? LAB_SOURCES.none
		: state === "pending"
			? LAB_SOURCES.pending
			: state === "sources"
				? LAB_SOURCES.mixed
				: LAB_SOURCES.synced

const failure = toLoadFailure("The warehouse did not answer in time")

const argsOf = <A, I>(input: Schema.Codec<A, I>) =>
	Schema.decodeUnknownOption(Schema.Struct({ key: Schema.String, input }))
const keyArgs = Schema.decodeUnknownOption(Schema.Struct({ key: Schema.String }))
const windowArgs = argsOf(WindowInput)
const timeseriesArgs = argsOf(TimeseriesInput)
const breakdownArgs = argsOf(BreakdownInput)

/** A read's answer: the fixture's, or the outage in the `error` state. */
const settled = <A>(state: LabState, value: () => A): Result.Result<A, typeof failure> =>
	state === "error" ? Result.fail(failure) : Result.succeed(value())

/** A read the page asked for, answered from the fixture the way the API would. */
const answerOf = (state: LabState, search: Search, command: CostCommand): Option.Option<CostMessage> => {
	if (command.name === ResolveWindow.name)
		return Option.some(
			CostMessage.CompletedResolveWindow({
				window: { startTime: `${LAB_TODAY} 00:00:00`, endTime: `${LAB_TODAY} 14:30:00` },
				nowMs: LAB_NOW_MS,
				mode: "Load",
			}),
		)
	if (state === "loading") return Option.none()
	const days = daysOf(search)
	// An empty window: the sources have synced, and nothing matches.
	const filtersOf = (filters: WindowInput["filters"]) =>
		state === "empty-window" ? { account: ["000000000000"] } : filters
	switch (command.name) {
		case FetchCostSources.name:
			return Option.map(keyArgs(command.args), ({ key }) =>
				CostMessage.CompletedLoadSources({ key, result: Result.succeed(sourcesFor(state)) }),
			)
		case FetchCostTotals.name:
			return Option.map(windowArgs(command.args), ({ key, input }) =>
				CostMessage.CompletedLoadTotals({
					key,
					result: settled(state, () => labTotals({ days, filters: filtersOf(input.filters) })),
				}),
			)
		case FetchCostTimeseries.name:
			return Option.map(timeseriesArgs(command.args), ({ key, input }) =>
				CostMessage.CompletedLoadTimeseries({
					key,
					result: settled(state, () =>
						labTimeseries({
							days,
							filters: filtersOf(input.filters),
							groupBy: input.groupBy,
							limit: input.limit,
						}),
					),
				}),
			)
		case FetchCostBreakdown.name:
			return Option.map(breakdownArgs(command.args), ({ key, input }) =>
				CostMessage.CompletedLoadBreakdown({
					key,
					result: settled(state, () =>
						labBreakdown({
							days,
							filters: filtersOf(input.filters),
							groupBy: input.groupBy,
							sortBy: input.sortBy,
						}),
					),
				}),
			)
		default:
			return Option.none()
	}
}

type Step = Readonly<{ model: CostModel; commands: ReadonlyArray<CostCommand> }>

/**
 * Runs the page's reads against the fixture until none is left: an answer can ask for more (the
 * sources' answer asks for the window's reads). Kit commands are kept for the runtime.
 */
const settle = (state: LabState, step: Step): Step => {
	const answers = Arr.flatMap(step.commands, (command) =>
		Option.toArray(answerOf(state, step.model.search, command)),
	)
	const kept = keepLocal(step.commands)
	if (answers.length === 0) return { model: step.model, commands: kept }
	const next = Arr.reduce(
		answers,
		{ model: step.model, commands: Arr.empty<CostCommand>() },
		(acc, message) => {
			const result = Cost.update(acc.model, message, LAB_CONTEXT)
			return { model: result.model, commands: [...acc.commands, ...(result.commands ?? [])] }
		},
	)
	const rest = settle(state, next)
	return { model: rest.model, commands: [...kept, ...rest.commands] }
}

const lift = (commands: ReadonlyArray<CostCommand>) =>
	Command.mapMessages(commands, (message) => Message.GotCostMessage({ message }))

/** The search a page navigation lands on, read off its URL. */
const searchOfUrl = (url: string): Search =>
	Option.match(fromString(`https://lab.local${url}`), {
		onNone: (): Search => ({}),
		onSome: (parsed) => {
			const route = urlToAppRoute(parsed)
			return route._tag === "Cost" ? route.search : {}
		},
	})

export const init = (flags: Flags): Return => {
	const entered = Cost.init({ search: searchFor(flags.state) }, LAB_CONTEXT)
	const ready = settle(flags.state, { model: entered.model, commands: entered.commands ?? [] })
	return { model: { state: flags.state, cost: ready.model }, commands: lift(ready.commands) }
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotCostMessage: ({ message: child }) => {
			const step = Cost.update(model.cost, child, LAB_CONTEXT)
			const out = step.outMessage
			const moved =
				out?._tag === "RequestedNavigation"
					? Cost.routeChanged(step.model, { search: searchOfUrl(out.url) }, LAB_CONTEXT)
					: { model: step.model }
			const ready = settle(model.state, {
				model: moved.model,
				commands: [...(step.commands ?? []), ...(moved.commands ?? [])],
			})
			return { model: { ...model, cost: ready.model }, commands: lift(ready.commands) }
		},
	})

export const breadcrumbs = [{ label: "Lab", href: "/lab" }, { label: "Cost" }] as const

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.submodel({
		slotId: "cost-lab",
		model: model.cost,
		view: costView,
		viewInputs: { context: LAB_CONTEXT },
		toParentMessage: (message) => Message.GotCostMessage({ message }),
	})
