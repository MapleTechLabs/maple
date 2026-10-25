import { ErrorIssueId } from "@maple/domain/http"
import { V2ErrorIssueListQuery } from "@maple/domain/http/v2"
import {
	getErrorsByType,
	getErrorsFacets,
	getErrorsSpark,
	getErrorsSummary,
} from "@maple/web-data/warehouse/errors"
import { Clock, Duration, Effect, Queue, Schema, Stream } from "effect"
import { Command, Mount } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { resolveWindow, TimeWindow } from "../../../data/time-range"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { loadSignalPresences } from "../../kit/signal-presence"
import { Message, RequestMode } from "./message"
import { HubWrite, runHubWrite } from "./writes"
import { writeClipboard } from "../../kit/clipboard"

/** The warehouse side's filters: the trend window plus the sidebar's service and environment. */
export const WarehouseFilters = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	services: Schema.optional(Schema.Array(Schema.String)),
	deploymentEnvs: Schema.optional(Schema.Array(Schema.String)),
})
export type WarehouseFilters = typeof WarehouseFilters.Type

const mutable = <A>(values: ReadonlyArray<A> | undefined): Array<A> | undefined =>
	values === undefined ? undefined : [...values]

const warehouseData = (filters: WarehouseFilters) => ({
	startTime: filters.startTime,
	endTime: filters.endTime,
	services: mutable(filters.services),
	deploymentEnvs: mutable(filters.deploymentEnvs),
})

/** `useEffectiveTimeRange(undefined, undefined, ERRORS_WINDOW)`. */
export const ResolveWindow = Command.define("ResolveErrorsWindow", {
	args: { mode: RequestMode, preset: Schema.String, timeZone: Schema.String },
	messages: [Message.CompletedResolveWindow],
	execute: ({ mode, preset, timeZone }) =>
		Effect.map(Clock.currentTimeMillis, (nowMs) =>
			Message.CompletedResolveWindow({
				window: resolveWindow({ preset, snap: mode === "Load", timeZone }, nowMs),
				nowMs,
				mode,
			}),
		),
})

export const FetchSummary = Command.define("FetchErrorsSummary", {
	args: { key: Schema.String, filters: WarehouseFilters },
	messages: [Message.CompletedFetchSummary],
	execute: ({ key, filters }) =>
		getErrorsSummary({ data: warehouseData(filters) }).pipe(
			Effect.map((response) => response.data),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSummary({ key, result })),
		),
})

/** `errorIssues.serviceCounts`: open issues per service, the sidebar's Service section. */
export const FetchServiceCounts = Command.define("FetchErrorIssueServiceCounts", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchServiceCounts],
	execute: ({ key }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const response = yield* client.errorIssues.serviceCounts()
			return response.data
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchServiceCounts({ key, result })),
		),
})

/** `getErrorsFacets` over the trend window: the Environment section's names. */
export const FetchEnvironments = Command.define("FetchErrorsEnvironments", {
	args: { key: Schema.String, window: TimeWindow },
	messages: [Message.CompletedFetchEnvironments],
	execute: ({ key, window }) =>
		getErrorsFacets({ data: { startTime: window.startTime, endTime: window.endTime } }).pipe(
			Effect.map((response) => response.data.deploymentEnvs.map((env) => env.name)),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchEnvironments({ key, result })),
		),
})

/** The volume sort ranks fingerprints first (`VOLUME_RANK_LIMIT`). */
export const FetchRanking = Command.define("FetchErrorsRanking", {
	args: { key: Schema.String, filters: WarehouseFilters, limit: Schema.Number },
	messages: [Message.CompletedFetchRanking],
	execute: ({ key, filters, limit }) =>
		getErrorsByType({ data: { ...warehouseData(filters), limit } }).pipe(
			Effect.map((response) => response.data.map((row) => row.fingerprintHash)),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchRanking({ key, result })),
		),
})

export type ListQuery = typeof V2ErrorIssueListQuery.Type

/** One `errorIssues.list` page. */
export const FetchPage = Command.define("FetchErrorIssuesPage", {
	args: { key: Schema.String, query: V2ErrorIssueListQuery },
	messages: [Message.CompletedFetchPage],
	execute: ({ key, query }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const response = yield* client.errorIssues.list({ query })
			return { data: response.data, hasMore: response.has_more, nextCursor: response.next_cursor }
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchPage({ key, result })),
		),
})

/** Window counts for the rows on screen, asked for by fingerprint. */
export const FetchVolume = Command.define("FetchErrorsVolume", {
	args: { key: Schema.String, filters: WarehouseFilters, fingerprintHashes: Schema.Array(Schema.String) },
	messages: [Message.CompletedFetchVolume],
	execute: ({ key, filters, fingerprintHashes }) =>
		getErrorsByType({
			data: {
				...warehouseData(filters),
				fingerprintHashes: [...fingerprintHashes],
				limit: Math.max(1, fingerprintHashes.length),
			},
		}).pipe(
			Effect.map((response) => response.data),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchVolume({ key, result })),
		),
})

export const FetchSpark = Command.define("FetchErrorsSpark", {
	args: {
		key: Schema.String,
		filters: WarehouseFilters,
		fingerprintHashes: Schema.Array(Schema.String),
		bucketSeconds: Schema.Number,
	},
	messages: [Message.CompletedFetchSpark],
	execute: ({ key, filters, fingerprintHashes, bucketSeconds }) =>
		getErrorsSpark({
			data: { ...warehouseData(filters), fingerprintHashes: [...fingerprintHashes], bucketSeconds },
		}).pipe(
			Effect.map((response) => response.data),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSpark({ key, result })),
		),
})

/** `investigations.list` (`INVESTIGATIONS_LIMIT`), joined onto rows by issue. */
export const FetchInvestigations = Command.define("FetchErrorsInvestigations", {
	args: { key: Schema.String, limit: Schema.Number },
	messages: [Message.CompletedFetchInvestigations],
	execute: ({ key, limit }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiV2Client
			const response = yield* client.investigations.list({ query: { limit } })
			return response.data
		}).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchInvestigations({ key, result })),
		),
})

export const LoadSignalPresence = Command.define("LoadErrorsSignalPresence", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedLoadSignalPresence],
	execute: ({ orgId }) =>
		Effect.map(loadSignalPresences(orgId), (result) => Message.CompletedLoadSignalPresence({ result })),
})

/** `ToolbarSearch`'s 300 ms debounce; a newer keystroke bumps the generation. */
export const WaitSearchDebounce = Command.define("WaitErrorsSearchDebounce", {
	args: { generation: Schema.Number },
	messages: [Message.ElapsedSearchDebounce],
	execute: ({ generation }) =>
		Effect.as(Effect.sleep(Duration.millis(300)), Message.ElapsedSearchDebounce({ generation })),
})

/** `PageRefreshProvider`: how long Reload shows its pending spinner. */
export const CompleteReloadSpin = Command.define("CompleteErrorsReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})

/** The filter rail is in the DOM; the sidebar reads as it renders, so no paint wait. */
export const MountFilterRail = Mount.define("MountErrorsFilterRail", {
	messages: [Message.MountedFilterRail],
	execute: () => Effect.succeed(Message.MountedFilterRail()),
})

/** A row's or the selection's workflow write. */
export const RunHubWrite = Command.define("RunErrorsHubWrite", {
	args: { ids: Schema.Array(ErrorIssueId), write: HubWrite, isBulk: Schema.Boolean },
	messages: [Message.CompletedHubWrite],
	execute: ({ ids, write, isBulk }) =>
		runHubWrite(ids, write, (outcome) => Message.CompletedHubWrite({ ids, write, isBulk, outcome })),
})

/**
 * The row checkbox's click: Base UI hands the modifier keys to `onCheckedChange`, Foldkit's click
 * does not, so the list listens (capture) and reports the row and Shift. The click never reaches
 * the row's link, and a Shift press does not start a text selection.
 */
export const MountRowSelect = Mount.defineStream("MountErrorsRowSelect", {
	messages: [Message.ClickedRowSelect],
	execute: ({ element }) =>
		Stream.callback<typeof Message.ClickedRowSelect.Type>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const laneOf = (event: Event) =>
						event.target instanceof Element ? event.target.closest("[data-row-select]") : null
					const onClick = (event: Event) => {
						// A picker trigger inside the row's link opens its popover, never the issue.
						if (event.target instanceof Element && event.target.closest("[data-picker]") !== null)
							event.preventDefault()
						const id = laneOf(event)?.getAttribute("data-row-select")
						if (!(event instanceof MouseEvent) || id === null || id === undefined) return
						event.preventDefault()
						event.stopPropagation()
						Queue.offerUnsafe(queue, Message.ClickedRowSelect({ id, isShift: event.shiftKey }))
					}
					const onMouseDown = (event: Event) => {
						if (event instanceof MouseEvent && event.shiftKey && laneOf(event) !== null)
							event.preventDefault()
					}
					element.addEventListener("click", onClick, true)
					element.addEventListener("mousedown", onMouseDown, true)
					return { onClick, onMouseDown }
				}),
				({ onClick, onMouseDown }) =>
					Effect.sync(() => {
						element.removeEventListener("click", onClick, true)
						element.removeEventListener("mousedown", onMouseDown, true)
					}),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})

/** `useCopy({ label })` for a row; `isPath` copies an absolute link on this origin. */
export const CopyRowText = Command.define("CopyErrorsRowText", {
	args: { label: Schema.String, text: Schema.String, isPath: Schema.Boolean },
	messages: [Message.CompletedCopy],
	execute: ({ label, text, isPath }) =>
		Effect.map(writeClipboard(isPath ? `${window.location.origin}${text}` : text), (isOk) =>
			Message.CompletedCopy({ label, isOk }),
		),
})

/** "Open in new tab": `window.open(href, "_blank", "noopener,noreferrer")`. */
export const OpenInNewTab = Command.define("OpenErrorsRowInNewTab", {
	args: { path: Schema.String },
	messages: [Message.CompletedOpenInNewTab],
	execute: ({ path }) =>
		Effect.sync(() => {
			window.open(path, "_blank", "noopener,noreferrer")
			return Message.CompletedOpenInNewTab()
		}),
})
