import { OrgId } from "@maple/domain"
import { AiSessionListItem, AiToolErrorSampleCursor } from "@maple/domain/http"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { Option, Result, Schema } from "effect"
import { Command } from "foldkit"
import { fromString } from "foldkit/url"

import type { PageContext, PageOutMessage } from "../page/contract"
import * as ErrorModal from "../page/agent-sessions/tool/error-modal-model"
import { Message as ToolMessage } from "../page/agent-sessions/tool/message"
import type { Model as ToolModel } from "../page/agent-sessions/tool/model"
import { routeChanged, update as toolUpdate } from "../page/agent-sessions/tool/update"
import { Selection } from "../page/agent-sessions/tools-kit/reads"
import type { Resources } from "../platform/resources"
import { urlToAppRoute } from "../route"
import { BUCKET_MS, BUCKETS, buildToolCells, toolFixtureFacets } from "./agent-tools-fixture"
import { buildToolDetailFixture, buildToolErrorDetailFixture, buildToolErrorsFixture } from "./agent-tools-detail-fixture"

// The tools lab's "detail" view: the tool detail page and its error modal over the fixture week,
// its reads answered in place and its URL the lab's state.

type PageCommand = Command.Command<ToolMessage, never, Resources>
export type DetailStep = Readonly<{ model: ToolModel; commands?: ReadonlyArray<PageCommand>; outMessage?: PageOutMessage }>
export type Settled = Readonly<{ model: ToolModel; commands: ReadonlyArray<PageCommand> }>

export const contextOf = (timeZone: string): PageContext => ({
	orgId: Schema.decodeSync(OrgId)("org_lab"),
	pinnedNamespace: null,
	timeZone,
})

const SelectionArgs = Schema.Struct({ key: Schema.String, selection: Selection })
const decodeSelection = Schema.decodeUnknownOption(SelectionArgs)
const decodeKey = Schema.decodeUnknownOption(Schema.Struct({ key: Schema.String }))
const SamplesArgs = Schema.Struct({
	key: Schema.String,
	fingerprint: Schema.String,
	session: Schema.UndefinedOr(Schema.String),
	variant: Schema.UndefinedOr(Schema.String),
	before: Schema.UndefinedOr(AiToolErrorSampleCursor),
})
const decodeSamples = Schema.decodeUnknownOption(SamplesArgs)
const decodeSessions = Schema.decodeUnknownOption(Schema.Array(AiSessionListItem))

const SAMPLES_PAGE = 25

/** The fixture's reading of the page's search: the toolbar's filters as the lab's state carries them. */
const fixtureOf = (model: ToolModel) =>
	buildToolDetailFixture(
		model.toolName,
		{ service: model.search.service, env: model.search.env, model: model.search.model },
		model.nowMs,
		buildToolCells(model.nowMs),
	)

const errorRowOf = (model: ToolModel, fingerprint: string) =>
	buildToolErrorsFixture(model.toolName, model.nowMs).find((row) => row.fingerprint === fingerprint)

const modalAnswer = (message: ErrorModal.Message) => ToolMessage.GotErrorModalMessage({ message })

/** One page of the open group's samples, after the cursor the page holds, 25 at a time. */
const samplesPage = (model: ToolModel, args: typeof SamplesArgs.Type) => {
	const row = errorRowOf(model, args.fingerprint)
	if (row === undefined) return { occurrences: [], nextCursor: undefined }
	const all = buildToolErrorDetailFixture(model.toolName, row, {
		session: args.session,
		variant: args.variant,
		pages: Number.POSITIVE_INFINITY,
	}).occurrences
	const start = args.before === undefined ? 0 : all.findIndex((sample) => sample.spanId === args.before?.spanId) + 1
	const occurrences = all.slice(start, start + SAMPLES_PAGE)
	const last = occurrences.at(-1)
	return {
		occurrences,
		nextCursor:
			last === undefined || start + SAMPLES_PAGE >= all.length
				? undefined
				: { timestamp: formatWarehouseDateTime(last.timestamp), spanId: last.spanId },
	}
}

/** The fixture's answer to one of the page's reads; `None` for a Command that is not a read. */
const answer = (command: PageCommand, model: ToolModel): Option.Option<ToolMessage> => {
	const data = () => fixtureOf(model)
	switch (command.name) {
		case "FetchAgentToolSeries":
			return Option.map(decodeKey(command.args), ({ key }) =>
				ToolMessage.CompletedFetchSeries({ key, result: Result.succeed({ data: data().series, seriesKind: "none" }) }),
			)
		case "FetchAgentToolTotals":
			return Option.map(decodeSelection(command.args), ({ key }) => {
				const fixture = data()
				return ToolMessage.CompletedFetchTotals({
					key,
					result: Result.succeed({
						current: fixture.totals,
						previous: undefined,
						allSessions: 0,
						firstSeen: fixture.firstSeen,
						lastSeen: fixture.lastSeen,
						description: fixture.description,
					}),
				})
			})
		case "FetchAgentToolErrors":
			return Option.map(decodeKey(command.args), ({ key }) =>
				ToolMessage.CompletedFetchErrors({ key, result: Result.succeed({ data: data().errors }) }),
			)
		case "FetchAgentToolSessions":
			return Option.map(decodeKey(command.args), ({ key }) =>
				ToolMessage.CompletedFetchSessions({
					key,
					result: Result.succeed({ data: Option.getOrElse(decodeSessions(data().sessions), () => []) }),
				}),
			)
		case "FetchAgentToolFacets":
			return Option.map(decodeKey(command.args), ({ key }) =>
				ToolMessage.CompletedFetchFacets({
					key,
					result: Result.succeed({ vendors: [], agents: [], tools: [], ...toolFixtureFacets(buildToolCells(model.nowMs)) }),
				}),
			)
		default:
			return answerModal(command, model)
	}
}

/** The modal's reads, lifted into the page's Commands under their own names. */
const answerModal = (command: PageCommand, model: ToolModel): Option.Option<ToolMessage> => {
	switch (command.name) {
		case "FetchAgentToolErrorDetail":
			return Option.flatMap(
				Schema.decodeUnknownOption(Schema.Struct({ key: Schema.String, fingerprint: Schema.String }))(command.args),
				({ key, fingerprint }) =>
					Option.map(Option.fromUndefinedOr(errorRowOf(model, fingerprint)), (row) =>
						modalAnswer(
							ErrorModal.Message.CompletedFetchDetail({
								key,
								result: Result.succeed(buildToolErrorDetailFixture(model.toolName, row, { pages: 1 }).detail),
							}),
						),
					),
			)
		case "FetchAgentToolErrorSamples":
			return Option.map(decodeSamples(command.args), (args) =>
				modalAnswer(ErrorModal.Message.CompletedFetchSamples({ key: args.key, result: Result.succeed(samplesPage(model, args)) })),
			)
		default:
			return Option.none()
	}
}

/** The fixture's own week: `range` is `now - 56 buckets .. now`. */
const fixtureWindow = (command: PageCommand): PageCommand =>
	command.name === "ResolveAgentToolWindow"
		? Command.mapMessage(command, (message) =>
				message._tag === "CompletedResolveWindow"
					? ToolMessage.CompletedResolveWindow({
							...message,
							window: {
								startTime: formatWarehouseDateTime(message.nowMs - BUCKETS * BUCKET_MS),
								endTime: formatWarehouseDateTime(message.nowMs),
							},
						})
					: message,
			)
		: command

/** The page's navigations become the lab's state: the new search re-enters the page as the route would. */
const followNavigation = (model: ToolModel, outMessage: PageOutMessage | undefined, timeZone: string) => {
	if (outMessage?._tag !== "RequestedNavigation") return Option.none()
	return Option.flatMap(Option.map(fromString(`http://lab${outMessage.url}`), urlToAppRoute), (route) =>
		route._tag === "AgentSessionTool"
			? Option.some(routeChanged(model, { toolName: route.toolName, search: route.search }, contextOf(timeZone)))
			: Option.none(),
	)
}

/** Runs a page step to rest: reads are answered in place, navigations re-enter, the rest is returned. */
export const settle = (step: DetailStep, timeZone: string): Settled => {
	const resolved = (step.commands ?? []).map((command) => [command, answer(command, step.model)] as const)
	const rest = resolved.flatMap(([command, maybe]) => (Option.isNone(maybe) ? [fixtureWindow(command)] : []))
	const navigated = Option.match(followNavigation(step.model, step.outMessage, timeZone), {
		onNone: (): Settled => ({ model: step.model, commands: [] }),
		onSome: (next) => settle(next, timeZone),
	})
	return resolved
		.flatMap(([, maybe]) => Option.toArray(maybe))
		.reduce<Settled>(
			(result, message) => {
				const next = settle(toolUpdate(result.model, message, contextOf(timeZone)), timeZone)
				return { model: next.model, commands: [...result.commands, ...next.commands] }
			},
			{ model: navigated.model, commands: [...rest, ...navigated.commands] },
		)
}
