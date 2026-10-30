import type { SpanNodeData } from "@maple/web/page/traces/detail/trace-data"
import { Match, Option, Record, Result } from "effect"
import { AsyncData } from "foldkit"
import { accept, acceptCached, idle, keyOf } from "../../data/slot"
import {
	FetchSpanDetail,
	FetchSpanLogs,
	type TraceDetailCommand,
	WaitCopyStatus,
	WriteClipboard,
} from "./command"
import type { Message } from "./message"
import type { PanelModel } from "./panel-model"

// The span panel's own fields over its Messages. Its tabs, attributes panel and log sheet are
// child Blocks the page's Bindings run.

type Commands = ReadonlyArray<TraceDetailCommand>

/** What a panel step asks of the page: nothing, close the panel, or select another span. */
export type PanelOutcome = Readonly<{ _tag: "None" } | { _tag: "Close" } | { _tag: "Select"; spanId: string }>

export type PanelReturn = Readonly<{ panel: PanelModel; commands?: Commands; outcome?: PanelOutcome }>

const detailKey = (span: SpanNodeData) => keyOf("span-detail", { traceId: span.traceId, spanId: span.spanId })
const logsKey = (span: SpanNodeData) =>
	keyOf("span-logs", {
		traceId: span.traceId,
		spanId: span.spanId,
		startTime: span.startTime,
		durationMs: span.durationMs,
	})

/** The panel's reads: the logs always, the full attributes unless the span is a missing parent. */
const fetches = (span: SpanNodeData, apiBase: string, readsCache: boolean): Commands => [
	FetchSpanLogs({
		readsCache,
		key: logsKey(span),
		traceId: span.traceId,
		spanId: span.spanId,
		spanStartTime: span.startTime,
		spanDurationMs: span.durationMs,
		apiBase,
	}),
	...(span.isMissing === true
		? []
		: [
				FetchSpanDetail({
					key: detailKey(span),
					traceId: span.traceId,
					spanId: span.spanId,
					apiBase,
					readsCache,
				}),
			]),
]

/** `<SpanDetailPanel>` mounting for a newly selected span (the page restarts its child Blocks). */
export const initPanel = (span: SpanNodeData, apiBase: string): PanelReturn => ({
	panel: {
		span,
		detail:
			span.isMissing === true ? idle() : { ...idle(), key: detailKey(span), data: AsyncData.Loading() },
		logs: { ...idle(), key: logsKey(span), data: AsyncData.Loading() },
		copies: {},
		isErrorExpanded: false,
	},
	commands: fetches(span, apiBase, true),
})

/** A refresh (`invalidateQueries`) refetches the open panel's reads in place. */
export const refetchPanel = (panel: PanelModel, apiBase: string): PanelReturn => ({
	panel: {
		...panel,
		detail:
			panel.detail.key === null
				? panel.detail
				: { ...panel.detail, data: refreshing(panel.detail.data) },
		logs: { ...panel.logs, data: refreshing(panel.logs.data) },
	},
	commands: fetches(panel.span, apiBase, false),
})

const refreshing = <A, E>(data: AsyncData.AsyncData<A, E>): AsyncData.AsyncData<A, E> =>
	Option.getOrElse(AsyncData.revalidateOrLoad(data), () => data)

/** A copy's settled status, if it is still the latest copy of that target. */
const settleCopy = (
	panel: PanelModel,
	id: string,
	generation: number,
	status: "copied" | "error" | "idle",
): PanelReturn =>
	panel.copies[id]?.generation === generation
		? {
				panel: { ...panel, copies: Record.set(panel.copies, id, { status, generation }) },
				commands: status === "idle" ? [] : [WaitCopyStatus({ id, generation })],
			}
		: { panel }

/** The panel's fetch results and the web panel's header, copy and error Messages. */
export const updatePanel = (panel: PanelModel, message: Message): PanelReturn =>
	Match.value(message).pipe(
		Match.withReturnType<PanelReturn>(),
		Match.tags({
			SucceededFetchSpanDetail: ({ key, detail, fetchedAtMs }) => ({
				panel: { ...panel, detail: accept(panel.detail, key, Result.succeed(detail), fetchedAtMs) },
			}),
			FoundCachedSpanDetail: ({ request, cached }) =>
				panel.detail.key === request.key
					? {
							panel: {
								...panel,
								detail: acceptCached(panel.detail, request.key, cached, cached.isFresh),
							},
							commands: cached.isFresh
								? []
								: [FetchSpanDetail({ ...request, readsCache: false })],
						}
					: { panel },
			FoundCachedSpanLogs: ({ request, cached }) =>
				panel.logs.key === request.key
					? {
							panel: {
								...panel,
								logs: acceptCached(panel.logs, request.key, cached, cached.isFresh),
							},
							commands: cached.isFresh
								? []
								: [FetchSpanLogs({ ...request, readsCache: false })],
						}
					: { panel },
			FailedFetchSpanDetail: ({ key, failure }) => ({
				panel: { ...panel, detail: accept(panel.detail, key, Result.fail(failure)) },
			}),
			SucceededFetchSpanLogs: ({ key, logs, fetchedAtMs }) => ({
				panel: { ...panel, logs: accept(panel.logs, key, Result.succeed(logs), fetchedAtMs) },
			}),
			FailedFetchSpanLogs: ({ key, failure }) => ({
				panel: { ...panel, logs: accept(panel.logs, key, Result.fail(failure)) },
			}),
			ClickedClose: () => ({ panel, outcome: { _tag: "Close" } }),
			ClickedParentSpan: ({ spanId }) => ({ panel, outcome: { _tag: "Select", spanId } }),
			ClickedCopy: ({ id, text }) => {
				const generation = (panel.copies[id]?.generation ?? 0) + 1
				const status = panel.copies[id]?.status ?? "idle"
				const next = { ...panel, copies: Record.set(panel.copies, id, { status, generation }) }
				return text === ""
					? settleCopy(next, id, generation, "error")
					: { panel: next, commands: [WriteClipboard({ id, text, generation })] }
			},
			ToggledErrorExpanded: () => ({ panel: { ...panel, isErrorExpanded: !panel.isErrorExpanded } }),
			SucceededCopy: ({ id, generation }) => settleCopy(panel, id, generation, "copied"),
			FailedCopy: ({ id, generation }) => settleCopy(panel, id, generation, "error"),
			CompletedWriteClipboard: ({ id, generation, isOk }) =>
				settleCopy(panel, id, generation, isOk ? "copied" : "error"),
			ElapsedCopyStatus: ({ id, generation }) => settleCopy(panel, id, generation, "idle"),
		}),
		// The web panel's fetches, disclosures and filters are not the local panel's.
		Match.orElse(() => ({ panel })),
	)
