import { Record } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Keyed from "../../../../data/keyed"
import { requestKey } from "../../../../data/request-key"
import type { Resources } from "../../../../platform/resources"
import { AppRoute, hrefOf } from "../../../../route"
import * as Tabs from "../../../../ui/tabs"
import * as InfraCorrelation from "../../../kit/infra-correlation"
import type { SpanNodeData } from "../trace-data"
import { FetchSpanDetail, FetchSpanLogs, LOG_LIMIT, WaitSpanCopyStatus, WriteSpanClipboard } from "./command"
import { Message, OutMessage } from "./message"
import type { CopyStatus, Model, PanelState } from "./model"

export type InitInput = Readonly<{
	span: SpanNodeData
	traceId: string
	traceStartTime: string
	totalDurationMs: number
	orgId: string
}>

export type Return = Readonly<{
	model: Model
	commands?: ReadonlyArray<Command.Command<Message, never, Resources>>
	outMessage?: OutMessage
}>

type StateReturn<S> = Readonly<{
	model: S
	commands?: ReadonlyArray<Command.Command<Message, never, Resources>>
	outMessage?: OutMessage
}>

export const TAB_VALUES =["details", "logs", "infrastructure"] as const

/** The panel as it mounts: the logs read always, the full attributes unless the span is missing. */
export const init = (input: InitInput): Return => {
	const { span } = input
	const logsKey = requestKey(input.orgId, "listLogs", {
		data: { traceId: span.traceId, spanId: span.spanId, limit: LOG_LIMIT },
	})
	const detailKey = requestKey(input.orgId, "getSpanDetail", {
		data: { traceId: span.traceId, spanId: span.spanId, timestamp: span.startTime },
	})
	const hasDetail = span.isMissing !== true
	return {
		model: {
			span,
			traceStartTime: input.traceStartTime,
			totalDurationMs: input.totalDurationMs,
			detail: hasDetail ? { key: detailKey, data: AsyncData.Loading() } : Keyed.idle(),
			logs: { key: logsKey, data: AsyncData.Loading() },
			tabs: Tabs.init({ idBase: 32, values: TAB_VALUES, selected: "details" }),
			copies: {},
			openIds: [],
			isErrorExpanded: false,
			infra: InfraCorrelation.init(`span-${span.spanId}-infra`, input.orgId),
		},
		commands: [
			FetchSpanLogs({ key: logsKey, traceId: span.traceId, spanId: span.spanId }),
			...(hasDetail
				? [
						FetchSpanDetail({
							key: detailKey,
							traceId: span.traceId,
							spanId: span.spanId,
							timestamp: span.startTime,
						}),
					]
				: []),
		],
	}
}

const copyStatus = <S extends PanelState>(
	model: S,
	id: string,
	generation: number,
	status: CopyStatus,
): StateReturn<S> =>
	model.copies[id]?.generation === generation
		? {
				model: { ...model, copies: Record.set(model.copies, id, { status, generation }) },
				commands: [WaitSpanCopyStatus({ id, generation })],
			}
		: { model }

const toggled = (ids: ReadonlyArray<string>, id: string): ReadonlyArray<string> =>
	ids.includes(id) ? ids.filter((open) => open !== id) : [...ids, id]

/** `TraceAttributeFilterProvider`: a fresh list query carrying only this attribute. */
const attributeFilterUrl = (scope: "span" | "resource", key: string, value: string, isExclude: boolean) => {
	const entry = isExclude ? { key, value, negated: true } : { key, value }
	return hrefOf(
		AppRoute.Traces({
			search:
				scope === "resource" ? { resourceAttributeFilters: [entry] } : { attributeFilters: [entry] },
		}),
	)
}

/** The panel's reads, copies and disclosures over any model holding them (the session popover's too). */
export const updateState = <S extends PanelState>(model: S, message: Message): StateReturn<S> =>
	Message.match<StateReturn<S>>(message, {
		CompletedFetchDetail: ({ key, result }) => ({
			model: { ...model, detail: Keyed.accept(model.detail, key, result) },
		}),
		CompletedFetchLogs: ({ key, result }) => ({
			model: { ...model, logs: Keyed.accept(model.logs, key, result) },
		}),
		ClickedClose: () => ({ model, outMessage: OutMessage.Closed() }),
		ClickedParentSpan: ({ spanId }) => ({ model, outMessage: OutMessage.SelectedSpanId({ spanId }) }),
		ClickedCopy: ({ id, text }) => {
			const generation = (model.copies[id]?.generation ?? 0) + 1
			const status = model.copies[id]?.status ?? "idle"
			const next = { ...model, copies: Record.set(model.copies, id, { status, generation }) }
			return text === ""
				? copyStatus(next, id, generation, "error")
				: { model: next, commands: [WriteSpanClipboard({ id, text, generation })] }
		},
		SucceededCopy: ({ id, generation }) => copyStatus(model, id, generation, "copied"),
		FailedCopy: ({ id, generation }) => copyStatus(model, id, generation, "error"),
		ElapsedCopyStatus: ({ id, generation }) =>
			model.copies[id]?.generation === generation
				? {
						model: {
							...model,
							copies: Record.set(model.copies, id, { status: "idle", generation }),
						},
					}
				: { model },
		ToggledCollapsible: ({ id }) => ({ model: { ...model, openIds: toggled(model.openIds, id) } }),
		ToggledErrorExpanded: () => ({ model: { ...model, isErrorExpanded: !model.isErrorExpanded } }),
		ClickedAttributeFilter: ({ scope, key, value, isExclude }) => ({
			model,
			outMessage: OutMessage.RequestedNavigation({
				url: attributeFilterUrl(scope, key, value, isExclude),
			}),
		}),
		// The panel's own tab strip and Infrastructure tab; a holder without them keeps its state.
		GotTabsMessage: () => ({ model }),
		GotInfraMessage: () => ({ model }),
	})

export const update = (model: Model, message: Message): Return => {
	if (message._tag === "GotInfraMessage") {
		const next = InfraCorrelation.update(model.infra, message.message)
		return {
			model: { ...model, infra: next.model },
			commands: Command.mapMessages(next.commands ?? [], (inner) => Message.GotInfraMessage({ message: inner })),
		}
	}
	if (message._tag !== "GotTabsMessage") return updateState(model, message)
	const next = Tabs.update(model.tabs, message.message)
	return {
		model: { ...model, tabs: next.model },
		commands: Command.mapMessages(next.commands ?? [], (tab) => Message.GotTabsMessage({ message: tab })),
	}
}
