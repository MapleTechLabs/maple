import { resolveWindowCommand } from "../../kit/time-frame"
import { getCustomChartServiceSparklines } from "@maple/web-data/warehouse/custom-charts"
import { isMapleService, MAPLE_SERVICES_NAMESPACE } from "@maple/domain/uptime"
import {
	getServiceHealthBaseline,
	getServiceOverview,
	type GetServiceOverviewInput,
} from "@maple/web-data/warehouse/services"
import { Effect, Queue, Schema, Stream, Array as Arr, Record as Rec } from "effect"
import { Command, Mount } from "foldkit"
import { IdleTtl } from "../../../data/idle-ttl"
import { settleTo } from "@maple/views/data/load-failure"
import { readThrough } from "../../../data/read-cache"
import { TimeWindow } from "../../../data/time-range"
import { writeClipboard } from "@maple/views/ui/copy-button"
import { commitCardCommands, firstLine, readCommitDetails } from "../../kit/commit-card"
import { loadSignalPresences } from "../../kit/signal-presence"
import { fetchAnomaliesCommand } from "../../kit/service-health"
import { loadServicesFacets } from "../../../data/services-facets-probe"
import { Message } from "./message"
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

const toWarehouseInput = (input: OverviewInput): GetServiceOverviewInput => ({
	startTime: input.startTime,
	endTime: input.endTime,
	environments: input.environments,
	namespaces: input.namespaces,
	commitShas: input.commitShas,
	excludedEnvironments: input.excludedEnvironments,
	excludedNamespaces: input.excludedNamespaces,
	excludedCommitShas: input.excludedCommitShas,
})

/** Snapped on entry, re-resolved against the real clock on Reload. */
export const ResolveWindow = resolveWindowCommand("ResolveServicesWindow", Message.CompletedResolveWindow)

// Fetches carry their request key back so `update` drops a superseded answer.

export const FetchOverview = Command.define("FetchServiceOverview", {
	args: { key: Schema.String, refresh: Schema.Boolean, input: OverviewInput },
	messages: [Message.CompletedFetchOverview],
	execute: ({ key, refresh, input }) =>
		readThrough(
			{ key, refresh, idleTtlMs: IdleTtl.serviceOverview, schema: Schema.Array(ServiceRow) },
			// Maple's own services (uptime checks) stay off the list.
			Effect.map(getServiceOverview({ data: toWarehouseInput(input) }), (response) =>
				Arr.filter(response.data, (row) => !isMapleService(row)),
			),
		).pipe(settleTo((result) => Message.CompletedFetchOverview({ key, result }))),
})

export const FetchSparklines = Command.define("FetchServiceSparklines", {
	args: { key: Schema.String, refresh: Schema.Boolean, input: OverviewInput },
	messages: [Message.CompletedFetchSparklines],
	execute: ({ key, refresh, input }) =>
		readThrough(
			{ key, refresh, idleTtlMs: IdleTtl.serviceSparklines, schema: Sparklines },
			Effect.map(getCustomChartServiceSparklines({ data: toWarehouseInput(input) }), (response) =>
				Rec.fromEntries(
					Arr.map(Rec.toEntries(response.data), ([service, points]) => [
						service,
						{
							throughput: Arr.map(points, (point) => point.throughput),
							errorRate: Arr.map(points, (point) => point.errorRate),
						},
					]),
				),
			),
		).pipe(settleTo((result) => Message.CompletedFetchSparklines({ key, result }))),
})

/** Shared with the Overview through the facets probe. */
export const FetchFacets = Command.define("FetchServicesFacets", {
	args: { key: Schema.String, window: TimeWindow, refresh: Schema.Boolean },
	messages: [Message.CompletedFetchFacets],
	execute: ({ key, window, refresh }) =>
		loadServicesFacets(window, { refresh, key }).pipe(
			Effect.map(({ data }) => ({
				environments: data.environments,
				namespaces: Arr.filter(data.namespaces, (facet) => facet.name !== MAPLE_SERVICES_NAMESPACE),
				commitShas: data.commitShas,
			})),
			settleTo((result) => Message.CompletedFetchFacets({ key, result })),
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
				environments: input.environments,
				namespaces: input.namespaces,
			},
		}).pipe(
			Effect.map((response) => response.data),
			settleTo((result) => Message.CompletedFetchBaseline({ key, result })),
		),
})

export const FetchAnomalies = fetchAnomaliesCommand(
	"FetchOpenAnomalyServiceCounts",
	Message.CompletedFetchAnomalies,
)

/** Every deploy sha on screen in one request, first lines by sha. */
export const FetchCommitMessages = Command.define("FetchCommitMessages", {
	args: { key: Schema.String, shas: Schema.String },
	messages: [Message.CompletedFetchCommitMessages],
	execute: ({ key, shas }) =>
		Effect.gen(function* () {
			const response = yield* readCommitDetails(key, shas)
			return Rec.fromEntries(
				Arr.map(response.commits, (commit) => [commit.sha, firstLine(commit.message)]),
			)
		}).pipe(settleTo((result) => Message.CompletedFetchCommitMessages({ key, result }))),
})

/** The commit hover card's arm timer and its commit lookup. */
export const CommitCard = commitCardCommands(
	{ arm: "ArmServicesCommitLookup", fetch: "FetchServicesCommitDetail" },
	{ elapsed: Message.ElapsedCommitArm, completed: Message.CompletedFetchCommitDetail },
)

/** Where a click in the table goes: a service link is the link's alone (the row ignores it). */
export const tableLinkClick = (
	click: Readonly<{ href: string | null; button: number; hasModifier: boolean }>,
): "Row" | "Browser" | "Navigate" =>
	click.href === null ? "Row" : click.button !== 0 || click.hasModifier ? "Browser" : "Navigate"

const TableMessage = Schema.Union([Message.PaintedTable, Message.ClickedServiceLink])
type TableMessage = typeof TableMessage.Type

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

/** The commit SHA copy; the row navigation waits on it. */
export const CopyCommitSha = Command.define("CopyServicesCommitSha", {
	args: { sha: Schema.String, rowUrl: Schema.String },
	messages: [Message.CompletedCopyCommitSha],
	execute: ({ sha, rowUrl }) =>
		Effect.map(writeClipboard(sha), (isCopied) => Message.CompletedCopyCommitSha({ rowUrl, isCopied })),
})
