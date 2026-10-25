import { getCustomChartServiceSparklines } from "@maple/web-data/warehouse/custom-charts"
import {
	getServiceHealthBaseline,
	getServiceOverview,
	type GetServiceOverviewInput,
} from "@maple/web-data/warehouse/services"
import { Clock, Duration, Effect, Queue, Schema, Stream } from "effect"
import { Command, Mount } from "foldkit"
import { IdleTtl } from "../../../data/idle-ttl"
import { toLoadFailure } from "../../../data/load-failure"
import { readThrough } from "../../../data/read-cache"
import { resolveWindow, TimeWindow } from "../../../data/time-range"
import { writeClipboard } from "../../../ui/copy-button"
import { ARM_DELAY_MS, loadCommitDetail, readCommitDetails } from "../../kit/commit-card"
import { loadSignalPresences } from "../../kit/signal-presence"
import { loadAnomalyServiceCounts } from "../../../data/anomaly-service-counts"
import { loadServicesFacets } from "../../../data/services-facets-probe"
import { Message, RequestMode } from "./message"
import { ServiceRow, Sparklines } from "./model"

/** The overview, sparklines and baseline input: the window plus the URL filters, pin applied. */
export const OverviewInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	environments: Schema.optional(Schema.Array(Schema.String)),
	namespaces: Schema.optional(Schema.Array(Schema.String)),
	commitShas: Schema.optional(Schema.Array(Schema.String)),
	excludedEnvironments: Schema.optional(Schema.Array(Schema.String)),
	excludedNamespaces: Schema.optional(Schema.Array(Schema.String)),
	excludedCommitShas: Schema.optional(Schema.Array(Schema.String)),
})
export type OverviewInput = typeof OverviewInput.Type

const mutable = <A>(values: ReadonlyArray<A> | undefined): Array<A> | undefined =>
	values === undefined ? undefined : [...values]

const toWarehouseInput = (input: OverviewInput): GetServiceOverviewInput => ({
	startTime: input.startTime,
	endTime: input.endTime,
	environments: mutable(input.environments),
	namespaces: mutable(input.namespaces),
	commitShas: mutable(input.commitShas),
	excludedEnvironments: mutable(input.excludedEnvironments),
	excludedNamespaces: mutable(input.excludedNamespaces),
	excludedCommitShas: mutable(input.excludedCommitShas),
})

/** `useEffectiveTimeRange`: snapped on entry, re-resolved against the real clock on Reload. */
export const ResolveWindow = Command.define("ResolveServicesWindow", {
	args: {
		mode: RequestMode,
		startTime: Schema.optional(Schema.String),
		endTime: Schema.optional(Schema.String),
		preset: Schema.String,
		timeZone: Schema.String,
	},
	messages: [Message.CompletedResolveWindow],
	execute: ({ mode, startTime, endTime, preset, timeZone }) =>
		Effect.map(Clock.currentTimeMillis, (nowMs) =>
			Message.CompletedResolveWindow({
				window: resolveWindow({ startTime, endTime, preset, snap: mode === "Load", timeZone }, nowMs),
				nowMs,
				mode,
			}),
		),
})

// Fetches carry their request key back so `update` drops a superseded answer (S6).

export const FetchOverview = Command.define("FetchServiceOverview", {
	args: { key: Schema.String, refresh: Schema.Boolean, input: OverviewInput },
	messages: [Message.CompletedFetchOverview],
	execute: ({ key, refresh, input }) =>
		readThrough(
			{ key, refresh, idleTtlMs: IdleTtl.serviceOverview, schema: Schema.Array(ServiceRow) },
			Effect.map(getServiceOverview({ data: toWarehouseInput(input) }), (response) => response.data),
		).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchOverview({ key, result })),
		),
})

export const FetchSparklines = Command.define("FetchServiceSparklines", {
	args: { key: Schema.String, refresh: Schema.Boolean, input: OverviewInput },
	messages: [Message.CompletedFetchSparklines],
	execute: ({ key, refresh, input }) =>
		readThrough(
			{ key, refresh, idleTtlMs: IdleTtl.serviceSparklines, schema: Sparklines },
			Effect.map(getCustomChartServiceSparklines({ data: toWarehouseInput(input) }), (response) =>
				Object.fromEntries(
					Object.entries(response.data).map(([service, points]) => [
						service,
						{
							throughput: points.map((point) => point.throughput),
							errorRate: points.map((point) => point.errorRate),
						},
					]),
				),
			),
		).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSparklines({ key, result })),
		),
})

/** `getServicesFacetsResultAtom`: shared with the Overview through the facets probe. */
export const FetchFacets = Command.define("FetchServicesFacets", {
	args: { key: Schema.String, window: TimeWindow, refresh: Schema.Boolean },
	messages: [Message.CompletedFetchFacets],
	execute: ({ key, window, refresh }) =>
		loadServicesFacets(window, { refresh, key }).pipe(
			Effect.map(({ data }) => ({
				environments: data.environments,
				namespaces: data.namespaces,
				commitShas: data.commitShas,
			})),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchFacets({ key, result })),
		),
})

export const BaselineInput = Schema.Struct({
	rangeStartTime: Schema.String,
	environments: Schema.optional(Schema.Array(Schema.String)),
	namespaces: Schema.optional(Schema.Array(Schema.String)),
	excludedNamespaces: Schema.optional(Schema.Array(Schema.String)),
})
export type BaselineInput = typeof BaselineInput.Type

export const FetchBaseline = Command.define("FetchServiceHealthBaseline", {
	args: { key: Schema.String, input: BaselineInput },
	messages: [Message.CompletedFetchBaseline],
	execute: ({ key, input }) =>
		getServiceHealthBaseline({
			data: {
				rangeStartTime: input.rangeStartTime,
				environments: mutable(input.environments),
				namespaces: mutable(input.namespaces),
			},
		}).pipe(
			Effect.map((response) => response.data),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchBaseline({ key, result })),
		),
})

/** `openAnomalyServiceCountsAtom`. */
export const FetchAnomalies = Command.define("FetchOpenAnomalyServiceCounts", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchAnomalies],
	execute: ({ key }) =>
		loadAnomalyServiceCounts(key).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchAnomalies({ key, result })),
		),
})

/** `commitsQueryAtom(shasKey)`: every deploy sha on screen in one request, first lines by sha. */
export const FetchCommitMessages = Command.define("FetchCommitMessages", {
	args: { key: Schema.String, shas: Schema.String },
	messages: [Message.CompletedFetchCommitMessages],
	execute: ({ key, shas }) =>
		Effect.gen(function* () {
			const response = yield* readCommitDetails(key, shas)
			return Object.fromEntries(
				response.commits.map((commit) => [commit.sha, firstLine(commit.message)]),
			)
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchCommitMessages({ key, result })),
		),
})

/** `CommitShaHoverCard`'s arm timer: the lookup starts 20 ms into a hover, ahead of the card. */
export const ArmCommitLookup = Command.define("ArmServicesCommitLookup", {
	args: { sha: Schema.String, generation: Schema.Number },
	messages: [Message.ElapsedCommitArm],
	execute: ({ sha, generation }) =>
		Effect.as(Effect.sleep(Duration.millis(ARM_DELAY_MS)), Message.ElapsedCommitArm({ sha, generation })),
})

/** `commitQueryAtom(sha)`, for the hover card. */
export const FetchCommitDetail = Command.define("FetchServicesCommitDetail", {
	args: { key: Schema.String, sha: Schema.String },
	messages: [Message.CompletedFetchCommitDetail],
	execute: ({ key, sha }) =>
		Effect.map(loadCommitDetail(key, sha), (result) =>
			Message.CompletedFetchCommitDetail({ sha, result }),
		),
})

// The first line of a commit message.
const firstLine = (message: string): string => {
	const index = message.indexOf("\n")
	return (index === -1 ? message : message.slice(0, index)).trim()
}

/** Where a click in the table goes: a service link is the link's alone (the row ignores it). */
export const tableLinkClick = (
	click: Readonly<{ href: string | null; button: number; hasModifier: boolean }>,
): "Row" | "Browser" | "Navigate" =>
	click.href === null ? "Row" : click.button !== 0 || click.hasModifier ? "Browser" : "Navigate"

type TableMessage = typeof Message.PaintedTable.Type | typeof Message.ClickedServiceLink.Type

/** The loaded table is on screen; its service links navigate once, never through the row too. */
export const MountTable = Mount.defineStream("MountServicesTable", {
	messages: [Message.PaintedTable, Message.ClickedServiceLink],
	execute: ({ element }) =>
		Stream.callback<TableMessage>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const onClick = (event: Event) => {
						if (!(event instanceof MouseEvent) || !(event.target instanceof Element)) return
						const href = event.target.closest("a[href]")?.getAttribute("href") ?? null
						const hasModifier = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
						const intent = tableLinkClick({ href, button: event.button, hasModifier })
						if (intent === "Row" || href === null) return
						event.stopPropagation()
						if (intent === "Browser") return
						event.preventDefault()
						Queue.offerUnsafe(queue, Message.ClickedServiceLink({ url: href }))
					}
					element.addEventListener("click", onClick, true)
					const handle = requestAnimationFrame(() =>
						requestAnimationFrame(() => Queue.offerUnsafe(queue, Message.PaintedTable())),
					)
					return { onClick, handle }
				}),
				({ onClick, handle }) =>
					Effect.sync(() => {
						cancelAnimationFrame(handle)
						element.removeEventListener("click", onClick, true)
					}),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})

export const LoadSignalPresence = Command.define("LoadSignalPresence", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedLoadSignalPresence],
	execute: ({ orgId }) =>
		Effect.map(loadSignalPresences(orgId), (result) => Message.CompletedLoadSignalPresence({ result })),
})

/** `CopyableBadge`'s write for the commit SHA; the row navigation waits on it. */
export const CopyCommitSha = Command.define("CopyServicesCommitSha", {
	args: { sha: Schema.String, rowUrl: Schema.String },
	messages: [Message.CompletedCopyCommitSha],
	execute: ({ sha, rowUrl }) =>
		Effect.map(writeClipboard(sha), (isCopied) => Message.CompletedCopyCommitSha({ rowUrl, isCopied })),
})
