import { buildLogsLabFixture } from "../logs-fixture"
import {
	addLogAttributeFilter,
	type LogAttributeFilter,
	decodeLogAttributeFilters,
	matchesLogAttributeFilters,
} from "../../lib/logs/log-attribute-filters"
import { Duration, Effect, Option, Schema } from "effect"
import { Command, Update } from "foldkit"
import { modifyFields } from "foldkit/struct"
import { logTimeFormat, toLogRowView } from "../../ui/logs/log-row-view"
import * as LogsStream from "../../ui/logs/logs-stream"
import * as Menu from "../../ui/menu"
import type { Resources } from "../../platform/resources"
import { listFooterText, type ViewerFlags } from "../../ui/logs/viewer"
import { foldLabShell, initLabShell, type LabShellFlags } from "../app-shell"
import { foldLabToasts, initLabToasts } from "../toasts"
import { Message, type Model, type Toggle } from "./model"

const ANCHOR_MS = Date.UTC(2026, 9, 8, 14, 32, 10, 482)
const ALL_LOGS = buildLogsLabFixture(ANCHOR_MS)
/** Newest fixture rows held back at load; each reload reveals the next ones at the top. */
const LIVE_BACKLOG = 60
const ROWS_PER_TICK = 2
/** `PageRefreshProvider` keeps the reload button busy this long. */
const RELOAD_SPIN = Duration.millis(600)

type Return = Update.Return<Model, Message, Resources>
type Step = Update.Step<Model, Message, Resources>

// DERIVED

const visibleLogs = (model: Model) => {
	const hidden = Math.max(0, LIVE_BACKLOG - model.refreshVersion * ROWS_PER_TICK)
	const filters = decodeLogAttributeFilters(model.attrs)
	return ALL_LOGS.slice(hidden).filter((log) =>
		matchesLogAttributeFilters(filters, { log: log.logAttributes, resource: log.resourceAttributes }),
	)
}

/** The stream's rows, rebuilt whenever the data, pins or emptiness change. */
const rowsOf = (model: Model) => {
	const time = logTimeFormat(model.timeZone)
	return (model.isEmpty ? [] : visibleLogs(model)).map((log) => toLogRowView(log, model.pinned, time))
}

const footerOf = (model: Model, shown: number) => {
	const scope = Option.match(model.search, { onNone: () => "", onSome: (text) => ` matching “${text}”` })
	return listFooterText(model.locale, { shown, noun: `logs${scope}`, capped: false, hasMore: false })
}

// INIT

export const init = (flags: ViewerFlags & LabShellFlags): Return => {
	const shell = initLabShell(flags)
	const base: Model = {
		stream: LogsStream.init("logs-lab", []),
		footerText: "",
		timeZone: flags.timeZone,
		locale: flags.locale,
		refreshVersion: 0,
		isReloading: false,
		refreshInterval: 0,
		refreshMenu: Menu.init("logs-lab-refresh-menu"),
		isInspecting: false,
		isScrolledAway: false,
		wrap: false,
		density: "compact",
		search: Option.none(),
		pinned: [],
		isEmpty: false,
		attrs: [],
		toasts: initLabToasts(),
		shell: shell.model,
	}
	const rows = rowsOf(base)
	return {
		model: modifyFields(base, {
			stream: () => LogsStream.init("logs-lab", rows),
			footerText: () => footerOf(base, rows.length),
		}),
		commands: (shell.commands ?? []).map(
			Command.mapMessage((message) => Message.GotShellMessage({ message })),
		),
	}
}

// COMMAND

export const WaitReloadSpin = Command.define("WaitReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.ElapsedReloadSpin],
	execute: ({ version }) =>
		Effect.sleep(RELOAD_SPIN).pipe(Effect.as(Message.ElapsedReloadSpin({ version }))),
})

// STREAM

const unchanged: Step = (model) => ({ model })

/** A chip's "Filter in / out": the same `attrs` entry the /logs route would add to its URL. */
const addFilter =
	(filter: LogAttributeFilter): Step =>
	(model) =>
		replaceRows(modifyFields(model, { attrs: (attrs) => addLogAttributeFilter(attrs, filter) }))

const streamOutMessage = LogsStream.OutMessage.match<Step>({
	// TODO(log-detail): open the log detail sheet.
	OpenedLog: () => unchanged,
	ChangedInspecting:
		({ isInspecting, isScrolledAway }) =>
		(model) => ({
			model: modifyFields(model, {
				isInspecting: () => isInspecting,
				isScrolledAway: () => isScrolledAway,
			}),
		}),
	ChoseAttributeFilter: addFilter,
})

const streamSlot = {
	read: (model: Model) => Option.some(model.stream),
	write: (model: Model, stream: LogsStream.Model) => modifyFields(model, { stream: () => stream }),
	toParentMessage: (message: LogsStream.Message) => Message.GotStreamMessage({ message }),
	foldOutMessage: streamOutMessage,
}

const foldStream = Update.foldChild({ ...streamSlot, update: LogsStream.update })
const foldSetRows = Update.foldChild({ ...streamSlot, update: LogsStream.setRows })
const foldReplaceRows = Update.foldChild({ ...streamSlot, update: LogsStream.replaceRows })
const jumpToLatest = Update.foldChildStep({ ...streamSlot, update: LogsStream.jumpToLatest })

// UPDATE

/** Pins or search changed: the same logs, derived again. */
const rederive = (model: Model): Return => {
	const rows = rowsOf(model)
	return foldSetRows(modifyFields(model, { footerText: () => footerOf(model, rows.length) }), rows)
}

/** New rows on top, a filter, or emptied: the stream drops expansion it made on the old rows. */
const replaceRows = (model: Model): Return => {
	const rows = rowsOf(model)
	return foldReplaceRows(modifyFields(model, { footerText: () => footerOf(model, rows.length) }), rows)
}

const reload = (model: Model): Return => {
	const version = model.refreshVersion + 1
	return Update.combine(model, [
		(current) =>
			replaceRows(modifyFields(current, { refreshVersion: () => version, isReloading: () => true })),
		(current) => ({ model: current, commands: [WaitReloadSpin({ version })] }),
	])
}

const toggle = (model: Model, which: Toggle): Return => {
	switch (which) {
		case "Wrap":
			return { model: modifyFields(model, { wrap: (wrap) => !wrap }) }
		case "Comfortable":
			return {
				model: modifyFields(model, { density: (d) => (d === "compact" ? "comfortable" : "compact") }),
			}
		case "Search":
			return rederive(
				modifyFields(model, {
					search: (s) => (Option.isSome(s) ? Option.none() : Option.some("pool")),
				}),
			)
		case "Empty":
			return replaceRows(modifyFields(model, { isEmpty: (isEmpty) => !isEmpty }))
	}
}

const foldToasts = foldLabToasts<Model, Message>((message) => Message.GotToastMessage({ message }))
const foldShell = foldLabShell<Model, Message>((message) => Message.GotShellMessage({ message }))

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotStreamMessage: ({ message: streamMessage }) => foldStream(model, streamMessage),
		ClickedToggle: ({ toggle: which }) => toggle(model, which),
		ClickedPin: ({ key }) =>
			rederive(
				modifyFields(model, {
					pinned: (pinned) =>
						pinned.includes(key) ? pinned.filter((k) => k !== key) : [...pinned, key],
				}),
			),
		ClickedReload: () => reload(model),
		TickedAutoRefresh: () => reload(model),
		ClickedJumpToLatest: () => Update.combine(model, [jumpToLatest, reload]),
		ElapsedReloadSpin: ({ version }) =>
			version === model.refreshVersion
				? { model: modifyFields(model, { isReloading: () => false }) }
				: { model },
		GotToastMessage: ({ message }) => foldToasts(model, message),
		GotShellMessage: ({ message }) => foldShell(model, message),
		GotRefreshMenuMessage: ({ message }) => {
			const next = Menu.update(model.refreshMenu, message)
			return {
				model: modifyFields(model, {
					refreshMenu: () => next.model,
					refreshInterval: (current) =>
						next.outMessage?._tag === "SelectedRadio" ? Number(next.outMessage.value) : current,
				}),
				commands: Command.mapMessages(next.commands ?? [], (inner) =>
					Message.GotRefreshMenuMessage({ message: inner }),
				),
			}
		},
	})
