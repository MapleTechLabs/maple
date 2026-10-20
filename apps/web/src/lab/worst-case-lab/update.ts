import { Clock, Effect, Option, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { replaceUrl } from "foldkit/navigation"
import * as AlertsHub from "../../page/alerts/hub/update"
import * as ReleaseOverlays from "../../page/releases/overlays"
import type { PageContext } from "../../page/contract"
import { nextSort } from "../../page/kit/table-sort"
import type { Resources } from "../../platform/resources"
import { OrgId } from "@maple/domain"
import * as AttributesPanel from "../../ui/attributes/attributes-panel"
import * as LogsStream from "../../ui/logs/logs-stream"
import { foldLabToasts, initLabToasts } from "../toasts"
import { logRows, traceOf } from "./fixture"
import { type Flags, Message, type Model, type WorstCaseMode } from "./model"
import * as TraceBox from "./trace-box"

export type Return = Update.Return<Model, Message, Resources>

/** The boot clock, the browser's zone, and the route's `?data=` (default `worst`). */
export const worstCaseFlags: Effect.Effect<Flags> = Effect.all({
	nowMs: Clock.currentTimeMillis,
	timeZone: Effect.sync(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
	mode: Effect.sync(() =>
		new URLSearchParams(window.location.search).get("data") === "demo"
			? ("demo" satisfies WorstCaseMode)
			: "worst",
	),
})

/** `RulesTab` runs against a hub Model; its org is a fixture's, its admin rights on. */
const LAB_CONTEXT: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_lab_worst_case"),
	pinnedNamespace: null,
	timeZone: "UTC",
}

/** `onModeChange`: `navigate({ search: { data: mode }, replace: true })`. */
export const ReplaceModeUrl = Command.define("ReplaceModeUrl", {
	args: { mode: Schema.Literals(["demo", "worst"]) },
	messages: [Message.CompletedReplaceUrl],
	execute: ({ mode }) =>
		replaceUrl(`/lab/worst-case?data=${mode}`).pipe(Effect.as(Message.CompletedReplaceUrl())),
})

type BoxStep = Readonly<{ box: TraceBox.Model | null; commands: Return["commands"] }>

/** A `TraceBox` keyed by mode: a fresh box, its tab and the deepest span selected. */
const boxFor = (
	mode: WorstCaseMode,
	view: string,
	idBase: number,
	toMessage: (message: TraceBox.Message) => Message,
): BoxStep =>
	Option.match(traceOf(mode), {
		onNone: () => ({ box: null, commands: [] }),
		onSome: ({ trace, deepestSpanId }) => {
			const step = TraceBox.init({ trace, view, selectedSpanId: deepestSpanId, idBase })
			return { box: step.model, commands: Command.mapMessages(step.commands ?? [], toMessage) }
		},
	})

const boxes = (mode: WorstCaseMode) => {
	const waterfall = boxFor(mode, "waterfall", 20, (message) => Message.GotWaterfallBoxMessage({ message }))
	const timeline = boxFor(mode, "timeline", 30, (message) => Message.GotTimelineBoxMessage({ message }))
	return {
		waterfallBox: waterfall.box,
		timelineBox: timeline.box,
		commands: [...(waterfall.commands ?? []), ...(timeline.commands ?? [])],
	}
}

export const init = (flags: Flags): Return => {
	const { commands, ...traceBoxes } = boxes(flags.mode)
	const hub = AlertsHub.init({ _tag: "Alerts", search: {} }, LAB_CONTEXT).model
	return {
		model: {
			mode: flags.mode,
			nowMs: flags.nowMs,
			timeZone: flags.timeZone,
			...traceBoxes,
			hostSort: { key: "cpuPct", dir: "desc" },
			hiddenSeries: [],
			hub: { ...hub, isAdmin: true, nowMs: flags.nowMs },
			logs: LogsStream.init("wc-logs", logRows(flags.mode, flags.timeZone)),
			attributes: AttributesPanel.init("wc-attributes"),
			openTools: [],
			toasts: initLabToasts(),
			releaseOverlays: ReleaseOverlays.init("wc-release"),
		},
		commands,
	}
}

/** Only `RulesTab`'s own state moves: the search, show-all, row menus and broken logos. */
const isRulesLocal = (message: Message & { _tag: "GotRulesMessage" }): boolean => {
	const inner = message.message
	return (
		inner._tag === "ChangedRulesQuery" ||
		inner._tag === "ClickedShowAllRules" ||
		inner._tag === "FailedLoadProviderLogo" ||
		(inner._tag === "GotRowMenuMessage" && inner.message._tag !== "ClickedItem")
	)
}

const toggled = (list: ReadonlyArray<string>, key: string): ReadonlyArray<string> =>
	list.includes(key) ? list.filter((entry) => entry !== key) : [...list, key]

const liftBox = (
	box: TraceBox.Model | null,
	message: TraceBox.Message,
	write: (box: TraceBox.Model) => Model,
	toMessage: (message: TraceBox.Message) => Message,
	model: Model,
): Return => {
	if (box === null) return { model }
	const next = TraceBox.update(box, message)
	return { model: write(next.model), commands: Command.mapMessages(next.commands ?? [], toMessage) }
}

const foldToasts = foldLabToasts<Model, Message>((message) => Message.GotToastMessage({ message }))

/** The mode toggle: the URL follows, the trace boxes remount and the logs table gets the twin rows. */
const changeMode = (model: Model, mode: WorstCaseMode): Return => {
	if (mode === model.mode) return { model }
	const { commands, ...traceBoxes } = boxes(mode)
	const logs = LogsStream.replaceRows(model.logs, logRows(mode, model.timeZone))
	return {
		model: { ...model, mode, ...traceBoxes, logs: logs.model },
		commands: [
			ReplaceModeUrl({ mode }),
			...(commands ?? []),
			...Command.mapMessages(logs.commands ?? [], (message) => Message.GotLogsMessage({ message })),
		],
	}
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		ClickedMode: ({ mode }) => changeMode(model, mode),
		CompletedReplaceUrl: () => ({ model }),
		// The footers' `onLoadMore={() => undefined}`: the button is drawn, there is nothing to load.
		ClickedLoadMore: () => ({ model }),
		GotWaterfallBoxMessage: ({ message: inner }) =>
			liftBox(
				model.waterfallBox,
				inner,
				(box) => ({ ...model, waterfallBox: box }),
				(child) => Message.GotWaterfallBoxMessage({ message: child }),
				model,
			),
		GotTimelineBoxMessage: ({ message: inner }) =>
			liftBox(
				model.timelineBox,
				inner,
				(box) => ({ ...model, timelineBox: box }),
				(child) => Message.GotTimelineBoxMessage({ message: child }),
				model,
			),
		ToggledLegendSeries: ({ key }) => ({
			model: { ...model, hiddenSeries: toggled(model.hiddenSeries, key) },
		}),
		ClickedHostSort: ({ key }) => ({
			model: { ...model, hostSort: nextSort(model.hostSort, key, { stringKeys: ["hostName"] }) },
		}),
		// The row's selection, focus and picker handlers are no-ops.
		GotSignalRowMessage: () => ({ model }),
		GotRulesMessage: (got) => {
			if (!isRulesLocal(got)) return { model }
			const next = AlertsHub.update(model.hub, got.message, LAB_CONTEXT)
			return {
				model: { ...model, hub: next.model },
				commands: Command.mapMessages(next.commands ?? [], (child) =>
					Message.GotRulesMessage({ message: child }),
				),
			}
		},
		// `onLogClick` is a no-op and the attribute card has no filters, so out-messages are dropped.
		GotLogsMessage: ({ message: inner }) => {
			const next = LogsStream.update(model.logs, inner)
			return {
				model: { ...model, logs: next.model },
				commands: Command.mapMessages(next.commands ?? [], (child) =>
					Message.GotLogsMessage({ message: child }),
				),
			}
		},
		GotAttributesMessage: ({ message: inner }) => {
			const next = AttributesPanel.update(model.attributes, inner)
			return {
				model: { ...model, attributes: next.model },
				commands: Command.mapMessages(next.commands ?? [], (child) =>
					Message.GotAttributesMessage({ message: child }),
				),
			}
		},
		ToggledTool: ({ id }) => ({ model: { ...model, openTools: toggled(model.openTools, id) } }),
		GotToastMessage: ({ message: inner }) => foldToasts(model, inner),
		GotReleaseOverlaysMessage: ({ message: inner }) => {
			const next = ReleaseOverlays.update(model.releaseOverlays, inner, LAB_CONTEXT.orgId)
			return {
				model: { ...model, releaseOverlays: next.model },
				commands: Command.mapMessages(next.commands ?? [], (child) =>
					Message.GotReleaseOverlaysMessage({ message: child }),
				),
			}
		},
	})
