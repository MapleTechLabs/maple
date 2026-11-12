import * as Policy from "@maple/domain/policy"
import { toLoadFailure } from "@maple/views/data/load-failure"
import * as Field from "@maple/views/ui/field"
import { Array as Arr, Effect, Option, Record as Rec, Result, Schema } from "effect"
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
	ReadCostGrants,
	RemoveCloudflareCostToken,
	RemoveOpenRouterCostKey,
	ResolveWindow,
	SaveCloudflareCostToken,
	SaveOpenRouterCostKey,
	TimeseriesInput,
	WindowInput,
} from "../page/cost/command"
import { Message as CostMessage } from "../page/cost/message"
import { Model as CostModel, type Search } from "../page/cost/model"
import type { CredentialProvider } from "../page/cost/providers"
import * as Cost from "../page/cost/update"
import { view as costView } from "../page/cost/view"
import type { Resources } from "../platform/resources"
import { urlToAppRoute } from "../route"
import {
	LAB_NOW_MS,
	LAB_SOURCES,
	LAB_TODAY,
	type LabSourceChanges,
	labBreakdown,
	labSourcesWith,
	labTimeseries,
	labTotals,
} from "./cost-fixture"
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
	"by-provider",
	"add-source",
	"add-openrouter",
	"key-refused",
	"replace-key",
	"remove-source",
	"add-cloudflare",
	"token-refused",
	"replace-token",
	"remove-cloudflare",
	"member",
	"member-onramp",
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

export const Model = Schema.Struct({
	state: LabState,
	/** Each pasted-credential source added (true) or removed (false) since the state loaded; null before either. */
	changes: Schema.Struct({
		openrouter: Schema.NullOr(Schema.Boolean),
		cloudflare: Schema.NullOr(Schema.Boolean),
	}),
	cost: CostModel,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({ GotCostMessage: { message: CostMessage } })
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message, Resources>
/** What the lab answers from: the state it loaded in, and what the reader did to its sources since. */
type World = Readonly<{ state: LabState; changes: LabSourceChanges }>

const NO_CHANGES: LabSourceChanges = { openrouter: null, cloudflare: null }
type CostCommand = Command.Command<CostMessage, never, Resources>

const searchFor = (state: LabState): Search =>
	state === "filtered"
		? { groupBy: "region", cloud_service: ["Example Compute"] }
		: state === "by-provider"
			? { groupBy: "provider" }
			: {}

/** The states that start with nothing connected, so the dialog offers every provider. */
const startsEmpty = (state: LabState): boolean =>
	state === "onramp" ||
	state === "member-onramp" ||
	state === "add-source" ||
	state === "add-openrouter" ||
	state === "key-refused" ||
	state === "add-cloudflare" ||
	state === "token-refused"

/** What the reader did before the state's screenshot: the clicks that open its dialog. */
const openingOf = (state: LabState): ReadonlyArray<CostMessage> => {
	switch (state) {
		case "add-source":
			return [CostMessage.ClickedAddSource()]
		case "add-openrouter":
			return [CostMessage.ClickedAddSource(), CostMessage.PickedProvider({ provider: "openrouter" })]
		case "key-refused":
			return [
				CostMessage.ClickedAddSource(),
				CostMessage.PickedProvider({ provider: "openrouter" }),
				CostMessage.GotCredentialDraftMessage({
					message: Field.Message.ChangedValue({ value: "sk-or-v1-0123456789abcdef0123456789" }),
				}),
				CostMessage.SubmittedCredential(),
			]
		case "replace-key":
			return [CostMessage.ClickedReplaceCredential({ provider: "openrouter" })]
		case "remove-source":
			return [CostMessage.ClickedRemoveSource({ provider: "openrouter" })]
		case "add-cloudflare":
			return [CostMessage.ClickedAddSource(), CostMessage.PickedProvider({ provider: "cloudflare" })]
		case "token-refused":
			return [
				CostMessage.ClickedAddSource(),
				CostMessage.PickedProvider({ provider: "cloudflare" }),
				CostMessage.GotCredentialDraftMessage({
					message: Field.Message.ChangedValue({ value: "cfut_0123456789abcdefghij0123456789" }),
				}),
				CostMessage.SubmittedCredential(),
			]
		case "replace-token":
			return [CostMessage.ClickedReplaceCredential({ provider: "cloudflare" })]
		case "remove-cloudflare":
			return [CostMessage.ClickedRemoveSource({ provider: "cloudflare" })]
		// Without Clerk the page starts with every permission: the member states take them away.
		case "member":
		case "member-onramp":
			return [CostMessage.CompletedReadGrants({ grants: [] })]
		default:
			return []
	}
}

const refusedKey = {
	...toLoadFailure("refused"),
	message:
		"This is a regular API key. Reading spend needs a management key, which you create under Settings, Management keys in OpenRouter.",
}

const refusedToken = {
	...toLoadFailure("refused"),
	message: "This token can read 3 accounts. Create one limited to a single account.",
}

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
	startsEmpty(state)
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

const removedAnswer = (provider: CredentialProvider) =>
	CostMessage.CompletedRemoveCredential({ provider, result: Result.succeed(undefined) })

/** A read's answer: the fixture's, or the outage in the `error` state. */
const settled = <A>(state: LabState, value: () => A): Result.Result<A, typeof failure> =>
	state === "error" ? Result.fail(failure) : Result.succeed(value())

/** A read the page asked for, answered from the fixture the way the API would. */
const answerOf = (world: World, search: Search, command: CostCommand): Option.Option<CostMessage> => {
	const { state } = world
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
	// A removed source's cost is not read any more, under any filter.
	const removed = Arr.flatMap(Rec.toEntries(world.changes), ([provider, added]) =>
		added === false ? [provider] : [],
	)
	switch (command.name) {
		case FetchCostSources.name:
			return Option.map(keyArgs(command.args), ({ key }) =>
				CostMessage.CompletedLoadSources({
					key,
					result: Result.succeed(labSourcesWith(sourcesFor(state), world.changes)),
				}),
			)
		case FetchCostTotals.name:
			return Option.map(windowArgs(command.args), ({ key, input }) =>
				CostMessage.CompletedLoadTotals({
					key,
					result: settled(state, () =>
						labTotals({ days, filters: filtersOf(input.filters), removed }),
					),
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
							removed,
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
							removed,
							groupBy: input.groupBy,
							sortBy: input.sortBy,
						}),
					),
				}),
			)
		case ReadCostGrants.name:
			return Option.some(
				CostMessage.CompletedReadGrants({
					grants: state === "member" || state === "member-onramp" ? [] : Policy.allPermissions,
				}),
			)
		case SaveOpenRouterCostKey.name:
			return Option.some(
				CostMessage.CompletedSaveCredential({
					provider: "openrouter",
					result: state === "key-refused" ? Result.fail(refusedKey) : Result.succeed(undefined),
				}),
			)
		case SaveCloudflareCostToken.name:
			return Option.some(
				CostMessage.CompletedSaveCredential({
					provider: "cloudflare",
					result: state === "token-refused" ? Result.fail(refusedToken) : Result.succeed(undefined),
				}),
			)
		case RemoveOpenRouterCostKey.name:
			return Option.some(removedAnswer("openrouter"))
		case RemoveCloudflareCostToken.name:
			return Option.some(removedAnswer("cloudflare"))
		default:
			return Option.none()
	}
}

type Step = Readonly<{ model: CostModel; commands: ReadonlyArray<CostCommand> }>
type Settled = Step & Pick<World, "changes">

/** A saved credential adds its provider to the sources the lab answers with next, a removal takes it out. */
const changesAfter = (changes: LabSourceChanges, answers: ReadonlyArray<CostMessage>): LabSourceChanges =>
	Arr.reduce(answers, changes, (current, answer) =>
		answer._tag === "CompletedSaveCredential" && Result.isSuccess(answer.result)
			? { ...current, [answer.provider]: true }
			: answer._tag === "CompletedRemoveCredential" && Result.isSuccess(answer.result)
				? { ...current, [answer.provider]: false }
				: current,
	)

/**
 * Runs the page's reads against the fixture until none is left: an answer can ask for more (the
 * sources' answer asks for the window's reads). Kit commands are kept for the runtime.
 */
const settle = (world: World, step: Step): Settled => {
	const answers = Arr.flatMap(step.commands, (command) =>
		Option.toArray(answerOf(world, step.model.search, command)),
	)
	const kept = keepLocal(step.commands)
	if (answers.length === 0) return { model: step.model, commands: kept, changes: world.changes }
	const next = Arr.reduce(
		answers,
		{ model: step.model, commands: Arr.empty<CostCommand>() },
		(acc, message) => {
			const result = Cost.update(acc.model, message, LAB_CONTEXT)
			return { model: result.model, commands: [...acc.commands, ...(result.commands ?? [])] }
		},
	)
	const rest = settle({ ...world, changes: changesAfter(world.changes, answers) }, next)
	return { ...rest, commands: [...kept, ...rest.commands] }
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
	const world: World = { state: flags.state, changes: NO_CHANGES }
	const loaded = settle(world, { model: entered.model, commands: entered.commands ?? [] })
	const ready = Arr.reduce(openingOf(flags.state), loaded, (step, message) => {
		const next = Cost.update(step.model, message, LAB_CONTEXT)
		const settled = settle(
			{ ...world, changes: step.changes },
			{ model: next.model, commands: next.commands ?? [] },
		)
		return { ...settled, commands: [...step.commands, ...settled.commands] }
	})
	return {
		model: { state: flags.state, changes: ready.changes, cost: ready.model },
		commands: lift(ready.commands),
	}
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
			const ready = settle(
				{ state: model.state, changes: model.changes },
				{ model: moved.model, commands: [...(step.commands ?? []), ...(moved.commands ?? [])] },
			)
			return {
				model: { ...model, changes: ready.changes, cost: ready.model },
				commands: lift(ready.commands),
			}
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
