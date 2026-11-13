import {
	GithubCostInstallations,
	GithubCostSourceAdded,
	GithubCostSourceRemoved,
	VercelCostSourceAdded,
	VercelCostSourceRemoved,
	VercelCostStatus,
} from "@maple/domain/http"
import { VcsInstallationId } from "@maple/domain/vcs"
import * as Policy from "@maple/domain/policy"
import { toLoadFailure } from "@maple/views/data/load-failure"
import * as Field from "@maple/views/ui/field"
import { Array as Arr, Effect, Option, Result, Schema } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { fromString } from "foldkit/url"
import {
	AddGithubCostSource,
	AddVercelCostSource,
	BreakdownInput,
	FacetsInput,
	FetchCostBreakdown,
	FetchCostFacets,
	FetchCostSources,
	FetchCostTimeseries,
	FetchCostTotals,
	FetchGithubCostInstallations,
	FetchVercelCostStatus,
	ReadCostGrants,
	RemoveGithubCostSource,
	RemoveCloudflareCostToken,
	RemoveOpenRouterCostKey,
	RemoveVercelCostSource,
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
import { perDimension } from "../page/cost/derive"
import {
	LAB_NOW_MS,
	LAB_SOURCES,
	LAB_TODAY,
	LAB_VERCEL_TEAM,
	type LabSourceChanges,
	labBreakdown,
	labGithubInstallations,
	labGithubLogin,
	labRemovedProviders,
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
	"cloudflare",
	"by-resource",
	"add-source",
	"add-openrouter",
	"key-refused",
	"replace-key",
	"remove-source",
	"add-cloudflare",
	"token-refused",
	"token-too-broad",
	"replace-token",
	"remove-cloudflare",
	"add-github",
	"github-refused",
	"github-none",
	"remove-github",
	"add-vercel",
	"vercel-not-connected",
	"vercel-refused",
	"remove-vercel",
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
	/** OpenRouter added (true) or removed (false) since the state loaded; null before either. */
	openRouter: Schema.NullOr(Schema.Boolean),
	/** The same for Cloudflare. */
	cloudflare: Schema.NullOr(Schema.Boolean),
	/** GitHub installations added (true) or removed (false) since the state loaded, by id. */
	github: Schema.Record(Schema.String, Schema.Boolean),
	/** Vercel added (true) or removed (false) since the state loaded; null before either. */
	vercel: Schema.NullOr(Schema.Boolean),
	cost: CostModel,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({ GotCostMessage: { message: CostMessage } })
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message, Resources>
/** What the lab answers from: the state it loaded in, and what the reader added or removed since. */
type World = Readonly<{ state: LabState }> & LabSourceChanges
type CostCommand = Command.Command<CostMessage, never, Resources>

const searchFor = (state: LabState): Search =>
	state === "filtered"
		? { groupBy: "region", cloud_service: ["Example Compute"] }
		: state === "by-provider"
			? { groupBy: "provider" }
			: state === "by-resource"
				? { groupBy: "resource" }
				: state === "cloudflare"
					? { provider: ["cloudflare"] }
					: {}

/** The states that start with nothing connected, so the dialog offers every provider. */
const startsEmpty = (state: LabState): boolean =>
	state === "onramp" ||
	state === "member-onramp" ||
	state === "add-source" ||
	state === "add-openrouter" ||
	state === "key-refused" ||
	state === "add-cloudflare" ||
	state === "token-refused" ||
	state === "token-too-broad" ||
	state === "github-none" ||
	state === "add-vercel" ||
	state === "vercel-not-connected" ||
	state === "vercel-refused"

/** What the reader did before the state's screenshot: the clicks that open its dialog. */
const openingOf = (state: LabState): ReadonlyArray<CostMessage> => {
	switch (state) {
		case "add-source":
			return [CostMessage.ClickedAddSource()]
		case "add-openrouter":
			return [CostMessage.ClickedAddSource(), CostMessage.PickedProvider({ provider: "openrouter" })]
		case "key-refused":
			return submissionOf("openrouter", "sk-or-v1-0123456789abcdef0123456789")
		case "replace-key":
			return [CostMessage.ClickedReplaceCredential({ provider: "openrouter" })]
		case "remove-source":
			return removalOf("openrouter")
		case "add-cloudflare":
			return [CostMessage.ClickedAddSource(), CostMessage.PickedProvider({ provider: "cloudflare" })]
		case "token-refused":
		case "token-too-broad":
			return submissionOf("cloudflare", "cfut_0123456789abcdefghij0123456789")
		case "replace-token":
			return [CostMessage.ClickedReplaceCredential({ provider: "cloudflare" })]
		case "remove-cloudflare":
			return removalOf("cloudflare")
		case "add-github":
		case "github-none":
			return [CostMessage.ClickedAddSource(), CostMessage.ClickedAddGithub()]
		case "github-refused":
			return [
				CostMessage.ClickedAddSource(),
				CostMessage.ClickedAddGithub(),
				...Arr.map(
					Arr.filter(
						labGithubInstallations(LAB_SOURCES.synced).installations,
						(installation) => installation.state === "available",
					),
					({ installationId }) => CostMessage.ClickedAddGithubInstallation({ installationId }),
				),
			]
		case "remove-github":
			return removalOf("github")
		case "add-vercel":
		case "vercel-not-connected":
			return [CostMessage.ClickedAddSource(), CostMessage.ClickedAddVercel()]
		case "vercel-refused":
			return [
				CostMessage.ClickedAddSource(),
				CostMessage.ClickedAddVercel(),
				CostMessage.ClickedConfirmAddVercel(),
			]
		case "remove-vercel":
			return removalOf("vercel")
		// Without Clerk the page starts with every permission: the member states take them away.
		case "member":
		case "member-onramp":
			return [CostMessage.CompletedReadGrants({ grants: [] })]
		default:
			return []
	}
}

/** The clicks and typing that submit `secret` in `provider`'s credential form. */
const submissionOf = (provider: CredentialProvider, secret: string): ReadonlyArray<CostMessage> => [
	CostMessage.ClickedAddSource(),
	CostMessage.PickedProvider({ provider }),
	CostMessage.GotCredentialDraftMessage({ message: Field.Message.ChangedValue({ value: secret }) }),
	CostMessage.SubmittedCredential(),
]

/** The click on Remove in the row of the lab's source of `provider`. */
const removalOf = (provider: CredentialProvider | "github" | "vercel"): ReadonlyArray<CostMessage> =>
	Arr.map(
		Arr.filter(LAB_SOURCES.synced.sources, (source) => source.provider === provider),
		(source) => CostMessage.ClickedRemoveSource({ sourceId: source.id }),
	)

const refusedBilling = {
	...toLoadFailure("refused"),
	code: Cost.GITHUB_PERMISSION_MISSING_CODE,
	message:
		"GitHub has not granted Maple access to billing yet. Accept the new permission in the organization's GitHub App settings.",
}

const refusedVercel = {
	...toLoadFailure("refused"),
	message:
		"This Vercel token's role cannot read the team's billing. Use a token from an Owner, Member, Developer, Security, Billing or Enterprise Viewer role.",
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

const tooBroadToken = {
	...toLoadFailure("refused"),
	message:
		"This token can do more than read billing: it can also read account members and Workers scripts. Create one with only the Billing: Read permission.",
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

/** The org's Vercel connection as the state has it, and whether the page's sources hold its team. */
const vercelStatusOf = (world: World): VercelCostStatus =>
	new VercelCostStatus({
		team: world.state === "vercel-not-connected" ? null : LAB_VERCEL_TEAM,
		authFailed: false,
		added: Arr.some(
			labSourcesWith(sourcesFor(world.state), world).sources,
			(source) => source.provider === "vercel",
		),
	})

const failure = toLoadFailure("The warehouse did not answer in time")

const argsOf = <A, I>(input: Schema.Codec<A, I>) =>
	Schema.decodeUnknownOption(Schema.Struct({ key: Schema.String, input }))
const keyArgs = Schema.decodeUnknownOption(Schema.Struct({ key: Schema.String }))
const windowArgs = argsOf(WindowInput)
const timeseriesArgs = argsOf(TimeseriesInput)
const breakdownArgs = argsOf(BreakdownInput)
const installationArgs = Schema.decodeUnknownOption(Schema.Struct({ installationId: VcsInstallationId }))
const readArgs = Schema.decodeUnknownOption(Schema.Struct({ request: Schema.Number }))
const facetsArgs = argsOf(FacetsInput)

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
	const without = labRemovedProviders(world)
	switch (command.name) {
		case FetchCostSources.name:
			return Option.map(keyArgs(command.args), ({ key }) =>
				CostMessage.CompletedLoadSources({
					key,
					result: Result.succeed(labSourcesWith(sourcesFor(state), world)),
				}),
			)
		case FetchCostTotals.name:
			return Option.map(windowArgs(command.args), ({ key, input }) =>
				CostMessage.CompletedLoadTotals({
					key,
					result: settled(state, () =>
						labTotals({ days, filters: filtersOf(input.filters), without }),
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
							without,
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
							without,
							groupBy: input.groupBy,
							sortBy: input.sortBy,
						}),
					),
				}),
			)
		case FetchCostFacets.name:
			return Option.map(facetsArgs(command.args), ({ key, input }) =>
				CostMessage.CompletedLoadFacets({
					key,
					result: settled(state, () =>
						perDimension(
							(groupBy) =>
								labBreakdown({
									days,
									filters: filtersOf(input.filters[groupBy]),
									without,
									groupBy,
									sortBy: "cost",
								}).rows,
						),
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
					result:
						state === "token-refused"
							? Result.fail(refusedToken)
							: state === "token-too-broad"
								? Result.fail(tooBroadToken)
								: Result.succeed(undefined),
				}),
			)
		case RemoveOpenRouterCostKey.name:
			return Option.some(removedAnswer("openrouter"))
		case RemoveCloudflareCostToken.name:
			return Option.some(removedAnswer("cloudflare"))
		case FetchGithubCostInstallations.name:
			return Option.map(readArgs(command.args), ({ request }) =>
				CostMessage.CompletedLoadGithubInstallations({
					request,
					result: Result.succeed(
						state === "github-none"
							? new GithubCostInstallations({ installations: [] })
							: labGithubInstallations(labSourcesWith(sourcesFor(state), world)),
					),
				}),
			)
		case AddGithubCostSource.name:
			return Option.map(installationArgs(command.args), ({ installationId }) =>
				CostMessage.CompletedAddGithubSource({
					installationId,
					result:
						state === "github-refused"
							? Result.fail(refusedBilling)
							: Result.succeed(
									new GithubCostSourceAdded({
										accountLogin: labGithubLogin(installationId),
									}),
								),
				}),
			)
		case RemoveGithubCostSource.name:
			return Option.some(
				CostMessage.CompletedRemoveGithubSource({
					result: Result.succeed(new GithubCostSourceRemoved({ removed: true })),
				}),
			)
		case FetchVercelCostStatus.name:
			return Option.map(keyArgs(command.args), ({ key }) =>
				CostMessage.CompletedLoadVercelStatus({ key, result: Result.succeed(vercelStatusOf(world)) }),
			)
		case AddVercelCostSource.name:
			return Option.some(
				CostMessage.CompletedAddVercel({
					result:
						state === "vercel-refused"
							? Result.fail(refusedVercel)
							: Result.succeed(new VercelCostSourceAdded({ team: LAB_VERCEL_TEAM })),
				}),
			)
		case RemoveVercelCostSource.name:
			return Option.some(
				CostMessage.CompletedRemoveVercel({
					result: Result.succeed(new VercelCostSourceRemoved({ removed: true })),
				}),
			)
		default:
			return Option.none()
	}
}

const removedAnswer = (provider: CredentialProvider) =>
	CostMessage.CompletedRemoveCredential({ provider, result: Result.succeed(undefined) })

/** `changes` alone, without whatever else the value carries. */
const changesOf = ({ openRouter, cloudflare, github, vercel }: LabSourceChanges): LabSourceChanges => ({
	openRouter,
	cloudflare,
	github,
	vercel,
})

type Step = Readonly<{ model: CostModel; commands: ReadonlyArray<CostCommand> }>
type Settled = Step & LabSourceChanges

type Answered = Readonly<{ command: CostCommand; answer: CostMessage }>

/** A successful add puts a source in what the lab answers with next, a removal takes it out. */
const changesAfter = (changes: LabSourceChanges, answered: ReadonlyArray<Answered>): LabSourceChanges =>
	Arr.reduce(answered, changes, (current, { command, answer }): LabSourceChanges => {
		const withGithub = (installationId: string, isSource: boolean): LabSourceChanges => ({
			...current,
			github: { ...current.github, [installationId]: isSource },
		})
		const withCredential = (provider: CredentialProvider, isSource: boolean): LabSourceChanges =>
			provider === "openrouter"
				? { ...current, openRouter: isSource }
				: { ...current, cloudflare: isSource }
		switch (answer._tag) {
			case "CompletedSaveCredential":
				return Result.isSuccess(answer.result) ? withCredential(answer.provider, true) : current
			case "CompletedRemoveCredential":
				return Result.isSuccess(answer.result) ? withCredential(answer.provider, false) : current
			case "CompletedAddGithubSource":
				return Result.isSuccess(answer.result) ? withGithub(answer.installationId, true) : current
			// The answer does not name the installation: the removal that was asked for does.
			case "CompletedRemoveGithubSource":
				return Option.match(installationArgs(command.args), {
					onNone: () => current,
					onSome: ({ installationId }) =>
						Result.isSuccess(answer.result) ? withGithub(installationId, false) : current,
				})
			case "CompletedAddVercel":
				return Result.isSuccess(answer.result) ? { ...current, vercel: true } : current
			case "CompletedRemoveVercel":
				return Result.isSuccess(answer.result) ? { ...current, vercel: false } : current
			default:
				return current
		}
	})

/**
 * Runs the page's reads against the fixture until none is left: an answer can ask for more (the
 * sources' answer asks for the window's reads). Kit commands are kept for the runtime.
 */
const settle = (world: World, step: Step): Settled => {
	const answered = Arr.flatMap(step.commands, (command) =>
		Option.toArray(
			Option.map(answerOf(world, step.model.search, command), (answer) => ({ command, answer })),
		),
	)
	const answers = Arr.map(answered, ({ answer }) => answer)
	const kept = keepLocal(step.commands)
	if (answers.length === 0) {
		return { model: step.model, commands: kept, ...changesOf(world) }
	}
	const next = Arr.reduce(
		answers,
		{ model: step.model, commands: Arr.empty<CostCommand>() },
		(acc, message) => {
			const result = Cost.update(acc.model, message, LAB_CONTEXT)
			return { model: result.model, commands: [...acc.commands, ...(result.commands ?? [])] }
		},
	)
	const rest = settle({ ...world, ...changesAfter(world, answered) }, next)
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
	const world: World = { state: flags.state, openRouter: null, cloudflare: null, github: {}, vercel: null }
	const loaded = settle(world, { model: entered.model, commands: entered.commands ?? [] })
	const ready = Arr.reduce(openingOf(flags.state), loaded, (step, message) => {
		const next = Cost.update(step.model, message, LAB_CONTEXT)
		const settled = settle(
			{ ...world, ...changesOf(step) },
			{ model: next.model, commands: next.commands ?? [] },
		)
		return { ...settled, commands: [...step.commands, ...settled.commands] }
	})
	return {
		model: { state: flags.state, ...changesOf(ready), cost: ready.model },
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
				{ state: model.state, ...changesOf(model) },
				{ model: moved.model, commands: [...(step.commands ?? []), ...(moved.commands ?? [])] },
			)
			return {
				model: { ...model, ...changesOf(ready), cost: ready.model },
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
