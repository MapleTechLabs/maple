import * as SpanPanelMessage from "@maple/web/page/traces/detail/span-panel/message"
import type { SpanNodeData } from "@maple/web/page/traces/detail/trace-data"
import * as AttributesPanel from "@maple/web/ui/attributes/attributes-panel"
import * as Tabs from "@maple/web/ui/tabs"
import { Match, Option, Record, Result } from "effect"
import { AsyncData, Command } from "foldkit"
import { accept, acceptCached, idle, keyOf } from "../../data/slot"
import * as LogSheet from "../kit/log-sheet/update"
import type { Resources } from "../../platform/resources"
import { FetchSpanDetail, FetchSpanLogs, WaitCopyStatus, WriteClipboard } from "./command"
import { Message } from "./message"
import { PANEL_TABS, type PanelModel } from "./panel-model"

type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>

/** What a panel step asks of the page: nothing, close the panel, or select another span. */
export type PanelOutcome = Readonly<{ _tag: "None" } | { _tag: "Close" } | { _tag: "Select"; spanId: string }>

export type PanelReturn = Readonly<{ panel: PanelModel; commands?: Commands; outcome?: PanelOutcome }>

const detailKey = (span: SpanNodeData) => keyOf("span-detail", { traceId: span.traceId, spanId: span.spanId })
const logsKey = (span: SpanNodeData) =>
	keyOf("span-logs", { traceId: span.traceId, spanId: span.spanId, startTime: span.startTime, durationMs: span.durationMs })

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
		: [FetchSpanDetail({ key: detailKey(span), traceId: span.traceId, spanId: span.spanId, apiBase, readsCache })]),
]

/** `<SpanDetailPanel>` mounting for a newly selected span. */
export const initPanel = (span: SpanNodeData, apiBase: string): PanelReturn => ({
	panel: {
		span,
		detail: span.isMissing === true ? idle() : { ...idle(), key: detailKey(span), data: AsyncData.Loading() },
		logs: { ...idle(), key: logsKey(span), data: AsyncData.Loading() },
		tabs: Tabs.init({ idBase: 40, values: PANEL_TABS, selected: "details" }),
		copies: {},
		isErrorExpanded: false,
		attributes: AttributesPanel.init("span-attributes"),
		maybeLogSheet: Option.none(),
	},
	commands: fetches(span, apiBase, true),
})

/** A refresh (`invalidateQueries`) refetches the open panel's reads in place. */
export const refetchPanel = (panel: PanelModel, apiBase: string): PanelReturn => ({
	panel: {
		...panel,
		detail: panel.detail.key === null ? panel.detail : { ...panel.detail, data: refreshing(panel.detail.data) },
		logs: { ...panel.logs, data: refreshing(panel.logs.data) },
	},
	commands: fetches(panel.span, apiBase, false),
})

const refreshing = <A, E>(data: AsyncData.AsyncData<A, E>): AsyncData.AsyncData<A, E> =>
	Option.getOrElse(AsyncData.revalidateOrLoad(data), () => data)

/** Folds a log sheet step into the panel. */
const liftSheet = (panel: PanelModel, step: LogSheet.UpdateReturn): PanelReturn => ({
	panel: { ...panel, maybeLogSheet: Option.some(step.model) },
	commands: Command.mapMessages(step.commands ?? [], (message) => Message.GotLogSheetMessage({ message })),
})

/** A copy's settled status, if it is still the latest copy of that target. */
const settleCopy = (panel: PanelModel, id: string, generation: number, status: "copied" | "error" | "idle"): PanelReturn =>
	panel.copies[id]?.generation === generation
		? {
				panel: { ...panel, copies: Record.set(panel.copies, id, { status, generation }) },
				commands: status === "idle" ? [] : [WaitCopyStatus({ id, generation })],
			}
		: { panel }

/** The web panel's header, copy and error Messages, over the local panel. */
const updateParts = (panel: PanelModel, message: SpanPanelMessage.Message): PanelReturn =>
	SpanPanelMessage.Message.match<PanelReturn>(message, {
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
		// Fetches, other copies' results, filters and the web tab strip are not the local panel's.
		CompletedFetchDetail: () => ({ panel }),
		CompletedFetchLogs: () => ({ panel }),
		SucceededCopy: ({ id, generation }) => settleCopy(panel, id, generation, "copied"),
		FailedCopy: ({ id, generation }) => settleCopy(panel, id, generation, "error"),
		ElapsedCopyStatus: ({ id, generation }) => settleCopy(panel, id, generation, "idle"),
		ToggledCollapsible: () => ({ panel }),
		ClickedAttributeFilter: () => ({ panel }),
		GotTabsMessage: () => ({ panel }),
		GotInfraMessage: () => ({ panel }),
	})

export const updatePanel = (panel: PanelModel, message: Message): PanelReturn =>
	Match.value(message).pipe(
		Match.withReturnType<PanelReturn>(),
		Match.tags({
		SucceededFetchSpanDetail: ({ key, detail, fetchedAtMs }) =>
			({ panel: { ...panel, detail: accept(panel.detail, key, Result.succeed(detail), fetchedAtMs) } }),
		FoundCachedSpanDetail: ({ request, cached }) =>
			panel.detail.key === request.key
				? {
						panel: { ...panel, detail: acceptCached(panel.detail, request.key, cached, cached.isFresh) },
						commands: cached.isFresh ? [] : [FetchSpanDetail({ ...request, readsCache: false })],
					}
				: { panel },
		FoundCachedSpanLogs: ({ request, cached }) =>
			panel.logs.key === request.key
				? {
						panel: { ...panel, logs: acceptCached(panel.logs, request.key, cached, cached.isFresh) },
						commands: cached.isFresh ? [] : [FetchSpanLogs({ ...request, readsCache: false })],
					}
				: { panel },
		FailedFetchSpanDetail: ({ key, failure }) => ({ panel: { ...panel, detail: accept(panel.detail, key, Result.fail(failure)) } }),
		SucceededFetchSpanLogs: ({ key, logs, fetchedAtMs }) =>
			({ panel: { ...panel, logs: accept(panel.logs, key, Result.succeed(logs), fetchedAtMs) } }),
		FailedFetchSpanLogs: ({ key, failure }) => ({ panel: { ...panel, logs: accept(panel.logs, key, Result.fail(failure)) } }),
		GotSpanPanelMessage: ({ message: child }) => updateParts(panel, child),
		GotPanelTabsMessage: ({ message: child }) => {
			const next = Tabs.update(panel.tabs, child)
			return {
				panel: { ...panel, tabs: next.model },
				commands: Command.mapMessages(next.commands ?? [], (tab) => Message.GotPanelTabsMessage({ message: tab })),
			}
		},
		GotAttributesMessage: ({ message: child }) => {
			const next = AttributesPanel.update(panel.attributes, child)
			return {
				panel: { ...panel, attributes: next.model },
				commands: Command.mapMessages(next.commands ?? [], (inner) => Message.GotAttributesMessage({ message: inner })),
			}
		},
		ClickedSpanLog: ({ log }) => liftSheet(panel, LogSheet.openLog(panel.maybeLogSheet, log)),
		GotLogSheetMessage: ({ message: child }) =>
			Option.match(panel.maybeLogSheet, {
				onNone: () => ({ panel }),
				onSome: (sheet) => liftSheet(panel, LogSheet.update(sheet, child)),
			}),
		CompletedWriteClipboard: ({ id, generation, isOk }) => settleCopy(panel, id, generation, isOk ? "copied" : "error"),
		ElapsedCopyStatus: ({ id, generation }) => settleCopy(panel, id, generation, "idle"),
		}),
		Match.orElse(() => ({ panel })),
	)
