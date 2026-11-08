import { ErrorIssueId, InvestigationId } from "@maple/domain/http"
import { getCustomChartTimeSeries } from "@maple/web-data/warehouse/custom-charts"
import { getServiceOverview } from "@maple/web-data/warehouse/services"
import { loadKnownServices } from "../conversation/kit/known-services"
import { Clock, Effect, type Result, Schema, Array as Arr, Option } from "effect"
import { Command, Mount } from "foldkit"
import { load } from "foldkit/navigation"
import { readLocalStorage, writeLocalStorage } from "@maple/ui/lib/local-storage"
import { isAgentTarget } from "@maple/web-data/investigations/agent-handoff"
import { writeClipboard } from "@maple/views/ui/copy-button"
import { clickStream, factsOf, nodeLinkClick } from "../clicks"
import { type LoadFailure, toLoadFailure } from "@maple/views/data/load-failure"
import { MapleApiV2Client, MapleInternalApiClient } from "../../../platform/api-clients"
import { Message } from "./message"
import { AgentTargetSchema } from "./model"

/** `KnownServicesProvider`: the org's service names, read once a thread shows its scroller. */
export const LoadKnownServices = Command.define("LoadInvestigationKnownServices", {
	messages: [Message.CompletedLoadKnownServices],
	execute: Effect.map(loadKnownServices, (services) => Message.CompletedLoadKnownServices({ services })),
})

/** Whether the focused element is keyboard-focused: Base UI opens a tooltip on keyboard focus only. */
export const CheckTipFocus = Command.define("CheckInvestigationTipFocus", {
	args: { triggerId: Schema.String },
	messages: [Message.CheckedTipFocus],
	execute: ({ triggerId }) =>
		Effect.sync(() =>
			Message.CheckedTipFocus({
				triggerId,
				isFocusVisible: document.getElementById(triggerId)?.matches(":focus-visible") === true,
			}),
		),
})

const finish = <A, E, R, M>(
	effect: Effect.Effect<A, E, R>,
	toMessage: (result: Result.Result<A, LoadFailure>) => M,
) => effect.pipe(Effect.mapError(toLoadFailure), Effect.result, Effect.map(toMessage))

export const ReadInvestigationClock = Command.define("ReadInvestigationClock", {
	messages: [Message.ReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.ReadClock({ nowMs })),
})

export const SignalWindowSchema = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	bucketSeconds: Schema.Number,
})

/** `LogsRow`: log count by severity for the service over the incident window. */
export const FetchSignalLogs = Command.define("FetchInvestigationSignalLogs", {
	args: { key: Schema.String, service: Schema.String, window: SignalWindowSchema },
	messages: [Message.CompletedFetchLogs],
	execute: ({ key, service, window }) =>
		finish(
			Effect.map(
				getCustomChartTimeSeries({
					data: {
						source: "logs",
						metric: "count",
						groupBy: "severity",
						startTime: window.startTime,
						endTime: window.endTime,
						bucketSeconds: window.bucketSeconds,
						filters: { serviceName: service },
					},
				}),
				(response) =>
					Arr.map(response.data, (point) => ({
						bucket: point.bucket,
						series: { ...point.series },
					})),
			),
			(result) => Message.CompletedFetchLogs({ key, result }),
		),
})

/** `TracesRow`'s read: the window's overview rows, every service, under the namespace pin. */
export const FetchSignalTraces = Command.define("FetchInvestigationSignalTraces", {
	args: {
		key: Schema.String,
		startTime: Schema.String,
		endTime: Schema.String,
		namespaces: Schema.optional(Schema.Array(Schema.String)),
	},
	messages: [Message.CompletedFetchTraces],
	execute: ({ key, startTime, endTime, namespaces }) =>
		finish(
			Effect.map(
				getServiceOverview({
					data: {
						startTime,
						endTime,
						namespaces: namespaces === undefined ? undefined : [...namespaces],
					},
				}),
				(response) =>
					Arr.map(response.data, ({ serviceName, spanCount, p95LatencyMs, errorRate }) => ({
						serviceName,
						spanCount,
						p95LatencyMs,
						errorRate,
					})),
			),
			(result) => Message.CompletedFetchTraces({ key, result }),
		),
})

/** `Escalation`: whether this run's diagnosis reached anyone. */
export const FetchEscalation = Command.define("FetchInvestigationEscalation", {
	args: { key: Schema.String, issueId: ErrorIssueId, investigationId: Schema.String },
	messages: [Message.CompletedFetchEscalation],
	execute: ({ key, issueId, investigationId }) =>
		finish(
			Effect.gen(function* () {
				const client = yield* MapleInternalApiClient
				const response = yield* client.errors.listIssueEscalations({ params: { issueId } })
				return Option.match(
					Arr.findFirst(
						response.attempts,
						(candidate) => candidate.investigationId === investigationId,
					),
					{
						onNone: () => null,
						onSome: (attempt) => ({
							status: attempt.status,
							destinations: Arr.map(attempt.deliveries, (delivery) => ({
								name: delivery.destinationName ?? delivery.destinationId,
								status: delivery.status,
							})),
						}),
					},
				)
			}),
			(result) => Message.CompletedFetchEscalation({ key, result }),
		),
})

export const ResolveInvestigation = Command.define("ResolveInvestigation", {
	args: { id: InvestigationId },
	messages: [Message.CompletedResolve],
	execute: ({ id }) =>
		finish(
			Effect.gen(function* () {
				const client = yield* MapleApiV2Client
				yield* client.investigations.updateStatus({ params: { id }, payload: { status: "resolved" } })
			}),
			(result) => Message.CompletedResolve({ result }),
		),
})

export const RestartInvestigation = Command.define("RestartInvestigation", {
	args: { id: InvestigationId },
	messages: [Message.CompletedRestart],
	execute: ({ id }) =>
		finish(
			Effect.gen(function* () {
				const client = yield* MapleApiV2Client
				yield* client.investigations.restart({ params: { id } })
			}),
			(result) => Message.CompletedRestart({ result }),
		),
})

/**
 * The canvas `<Link>`s: captured before the action card's own click, which they never trigger.
 * A plain click routes in place; a modified one keeps the browser's new tab.
 */
export const MountNodeLinks = Mount.defineStream("MountInvestigationNodeLinks", {
	messages: [Message.ClickedNodeLink],
	execute: ({ element }) =>
		clickStream<ReturnType<typeof Message.ClickedNodeLink>>(element, true, (event, emit) => {
			const link = nodeLinkClick(factsOf(event))
			if (link === null) return
			event.stopPropagation()
			if (!link.isPlain) return
			event.preventDefault()
			emit(Message.ClickedNodeLink({ href: link.href }))
		}),
})

const HANDOFF_TARGET_KEY = "maple.investigation.agent-target"

/** The agent the reader picked last time, and the origin the prompt links back to. */
export const ReadHandoff = Command.define("ReadInvestigationHandoff", {
	messages: [Message.ReadHandoff],
	execute: Effect.sync(() =>
		Message.ReadHandoff({
			target: Option.getOrNull(Option.filter(readLocalStorage(HANDOFF_TARGET_KEY), isAgentTarget)),
			origin: window.location.origin,
		}),
	),
})

export const SaveHandoffTarget = Command.define("SaveInvestigationHandoffTarget", {
	args: { target: AgentTargetSchema },
	messages: [Message.CompletedSaveHandoffTarget],
	execute: ({ target }) =>
		Effect.sync(() => {
			writeLocalStorage(HANDOFF_TARGET_KEY, target)
			return Message.CompletedSaveHandoffTarget()
		}),
})

/** The repository Claude Code opens in: only when the org connected exactly one, so it is never a guess. */
export const FetchHandoffRepo = Command.define("FetchInvestigationHandoffRepo", {
	messages: [Message.CompletedFetchHandoffRepo],
	execute: Effect.gen(function* () {
		const api = yield* MapleInternalApiClient
		const status = yield* api.integrations.githubStatus()
		const active = Arr.filter(status.repositories, (repo) => repo.status === "active")
		const only = active.length === 1 ? Arr.head(active) : Option.none()
		return Message.CompletedFetchHandoffRepo({
			repo: Option.getOrNull(Option.map(only, (repo) => repo.fullName)),
		})
	}).pipe(Effect.orElseSucceed(() => Message.CompletedFetchHandoffRepo({ repo: null }))),
})

/** A deep link chosen from the menu: the same navigation a click on the button's anchor makes. */
export const OpenHandoff = Command.define("OpenInvestigationHandoff", {
	args: { href: Schema.String },
	messages: [Message.CompletedOpenHandoff],
	execute: ({ href }) => load(href).pipe(Effect.as(Message.CompletedOpenHandoff())),
})

export const CopyHandoffPrompt = Command.define("CopyInvestigationHandoffPrompt", {
	args: { text: Schema.String },
	messages: [Message.CompletedCopyHandoffPrompt],
	execute: ({ text }) =>
		Effect.map(writeClipboard(text), (isOk) => Message.CompletedCopyHandoffPrompt({ isOk })),
})
