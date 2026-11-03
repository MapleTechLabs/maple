import { Duration, Effect, Schema, Array as Arr } from "effect"
import { Command, type Update } from "foldkit"
import * as AttributesPanel from "@maple/views/ui/attributes/attributes-panel"
import { type CopyStatus, writeClipboard } from "@maple/views/ui/copy-button"
import * as Dialog from "@maple/views/ui/dialog"
import type { LogRecord } from "@maple/views/ui/logs/log-row-view"
import * as Keyed from "@maple/views/data/keyed"
import * as Tabs from "@maple/views/ui/tabs"
import * as ToggleGroup from "@maple/views/ui/toggle-group"
import * as Tooltip from "@maple/views/ui/tooltip"
import type { LogSource } from "../log-source"
import { tabValues } from "./derive"
import { Message, type Model, OutMessage } from "./model"
import { requestPanels } from "./panels"

export type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage, LogSource>

const COPY_TIMEOUT = Duration.millis(2000)

/** Each `CopyButton`'s `label`; the `CopyableValue`s pass none. */
const COPY_LABELS = new Map([
	["hero-message", "message"],
	["meta-link", "Link to log"],
	["meta-json", "Log JSON"],
	["raw-json", "Log JSON"],
	["error-body", "Error"],
	["error-prompt", "error as an AI prompt"],
])

export const WriteDetailClipboard = Command.define("WriteDetailClipboard", {
	args: { text: Schema.String, generation: Schema.Number, copyId: Schema.String },
	messages: [Message.SucceededCopy, Message.FailedCopy],
	execute: ({ text, generation, copyId }) =>
		Effect.map(writeClipboard(text), (isOk) =>
			isOk ? Message.SucceededCopy({ generation, copyId }) : Message.FailedCopy({ generation, copyId }),
		),
})

/** `logPermalink`: the origin is read when copying, never in the view. */
export const WritePermalinkClipboard = Command.define("WritePermalinkClipboard", {
	args: { path: Schema.String, generation: Schema.Number, copyId: Schema.String },
	messages: [Message.SucceededCopy, Message.FailedCopy],
	execute: ({ path, generation, copyId }) =>
		Effect.suspend(() => writeClipboard(`${window.location.origin}${path}`)).pipe(
			Effect.map((isOk) =>
				isOk
					? Message.SucceededCopy({ generation, copyId })
					: Message.FailedCopy({ generation, copyId }),
			),
		),
})

export const WaitDetailCopyStatus = Command.define("WaitDetailCopyStatus", {
	args: { generation: Schema.Number },
	messages: [Message.ElapsedCopyStatus],
	execute: ({ generation }) =>
		Effect.sleep(COPY_TIMEOUT).pipe(Effect.as(Message.ElapsedCopyStatus({ generation }))),
})

const TABS_ID_BASE = 900

const initScope = () => ToggleGroup.init({ label: "Context scope", values: ["instance"] })

export type InitOptions = Readonly<{
	/** `/logs/$logId` shows every panel at once, outside a sheet. */
	isPage?: boolean
	/** The app's path for one log's page, before its key; without it, no full-page link or permalink. */
	logPagePath?: string
}>

export const init = (id: string, options: InitOptions = {}): Model => ({
	id,
	orgId: "",
	pinnedNamespace: null,
	isPage: options.isPage ?? false,
	logPagePath: options.logPagePath ?? null,
	isErrorExpanded: false,
	contextScope: initScope(),
	contextBefore: Keyed.idle(),
	contextAfter: Keyed.idle(),
	traceLogs: Keyed.idle(),
	traceSpans: Keyed.idle(),
	dialog: Dialog.init(id, "sheet"),
	log: null,
	tabs: Tabs.init({ idBase: TABS_ID_BASE, values: ["attributes"], selected: "attributes" }),
	attributes: AttributesPanel.init(`${id}-attributes`),
	isHeroExpanded: false,
	copy: { id: "", status: "idle", generation: 0 },
	tooltip: Tooltip.init(`${id}-tooltip`),
})

const liftDialog = (model: Model, result: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, dialog: result.model },
	commands: Command.mapMessages(result.commands ?? [], (message) => Message.GotDialogMessage({ message })),
	outMessage: result.outMessage?._tag === "Closed" ? OutMessage.Closed() : undefined,
})

/** A log on show: the attributes and context panels start fresh, the tooltip closed. */
const viewing = (model: Model, log: LogRecord, selected: string, hasInfra: boolean): Model => {
	const values = tabValues(log, hasInfra)
	const isSameTabs =
		model.tabs.selected === selected && Arr.join(values, ",") === Arr.join(model.tabs.values, ",")
	return {
		...model,
		log,
		tabs: isSameTabs
			? model.tabs
			: Tabs.init({
					idBase: TABS_ID_BASE,
					values,
					selected: values.includes(selected) ? selected : "attributes",
				}),
		attributes: AttributesPanel.init(`${model.id}-attributes`),
		tooltip: Tooltip.init(`${model.id}-tooltip`),
		contextScope: initScope(),
		isHeroExpanded: false,
		isErrorExpanded: false,
	}
}

const withPanels = (result: Return): Return => {
	const requested = requestPanels(result.model)
	return {
		...result,
		model: requested.model,
		commands: [...(result.commands ?? []), ...requested.commands],
	}
}

/** The org and namespace pin the panel reads are keyed under (`PageContext`'s). */
export type Scope = Readonly<{ orgId: string; pinnedNamespace: string | null }>

/**
 * Shows `log`, starting fresh on the Attributes tab with new panels. `hasInfra`: the app backs an
 * Infrastructure tab for this log (it passes the tab's body to the view).
 */
export const open = (model: Model, log: LogRecord, scope: Scope, hasInfra = false): Return =>
	withPanels(
		liftDialog(
			viewing(
				{ ...model, orgId: scope.orgId, pinnedNamespace: scope.pinnedNamespace },
				log,
				"attributes",
				hasInfra,
			),
			Dialog.open(model.dialog),
		),
	)

/** `/logs/$logId`: the page's log, every panel reading at once. */
export const show = (model: Model, log: LogRecord, scope: Scope): Return =>
	withPanels({
		model: viewing(
			{ ...model, orgId: scope.orgId, pinnedNamespace: scope.pinnedNamespace },
			log,
			"attributes",
			false,
		),
	})

/** The app closes the sheet (its page moved on, as to the trace the sheet linked to). */
export const close = (model: Model): Return => liftDialog(model, Dialog.close(model.dialog))

/** Another log in the open sheet (`SelectedLog`): its panels start fresh, the tab stays. */
export const viewLog = (model: Model, log: LogRecord, hasInfra = false): Return =>
	withPanels({ model: viewing(model, log, model.tabs.selected, hasInfra) })

const settled = (model: Model, generation: number, status: CopyStatus): Return =>
	generation === model.copy.generation
		? {
				model: { ...model, copy: { ...model.copy, status } },
				commands: [WaitDetailCopyStatus({ generation })],
			}
		: { model }

const startCopy = (model: Model, copyId: string) => {
	const generation = model.copy.generation + 1
	return { model: { ...model, copy: { id: copyId, status: "idle" as const, generation } }, generation }
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		GotDialogMessage: ({ message: inner }) => liftDialog(model, Dialog.update(model.dialog, inner)),
		GotTabsMessage: ({ message: inner }) => {
			const next = Tabs.update(model.tabs, inner)
			return withPanels({
				model: { ...model, tabs: next.model },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotTabsMessage({ message: m }),
				),
			})
		},
		ToggledErrorExpanded: () => ({ model: { ...model, isErrorExpanded: !model.isErrorExpanded } }),
		// `onValueChange` ignores an empty value: pressing the chosen scope keeps it.
		GotContextScopeMessage: ({ message: inner }) => {
			const next = ToggleGroup.update(model.contextScope, inner)
			const contextScope =
				next.model.values.length === 0
					? { ...next.model, values: model.contextScope.values }
					: next.model
			return withPanels({
				model: { ...model, contextScope },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotContextScopeMessage({ message: m }),
				),
			})
		},
		ClickedLog: ({ log }) => ({ model, outMessage: OutMessage.SelectedLog({ log }) }),
		PositionedLogRow: () => ({ model }),
		CompletedFetchContext: ({ key, side, result }) => ({
			model:
				side === "before"
					? { ...model, contextBefore: Keyed.accept(model.contextBefore, key, result) }
					: { ...model, contextAfter: Keyed.accept(model.contextAfter, key, result) },
		}),
		CompletedFetchTraceLogs: ({ key, result }) => ({
			model: { ...model, traceLogs: Keyed.accept(model.traceLogs, key, result) },
		}),
		CompletedFetchTraceSpans: ({ key, result }) => ({
			model: { ...model, traceSpans: Keyed.accept(model.traceSpans, key, result) },
		}),
		GotAttributesMessage: ({ message: inner }) => {
			const next = AttributesPanel.update(model.attributes, inner)
			return {
				model: { ...model, attributes: next.model },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotAttributesMessage({ message: m }),
				),
				outMessage:
					next.outMessage === undefined
						? undefined
						: OutMessage.ChoseAttributeFilter({
								source: next.outMessage.source,
								key: next.outMessage.key,
								value: next.outMessage.value,
								negated: next.outMessage.negated,
							}),
			}
		},
		GotTooltipMessage: ({ message: inner }) => {
			const next = Tooltip.update(model.tooltip, inner)
			return {
				model: { ...model, tooltip: next.model },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotTooltipMessage({ message: m }),
				),
			}
		},
		ClickedShowFullMessage: () => ({ model: { ...model, isHeroExpanded: !model.isHeroExpanded } }),
		ClickedCopy: ({ copyId, text }) => {
			const started = startCopy(model, copyId)
			return {
				model: started.model,
				commands: [WriteDetailClipboard({ text, generation: started.generation, copyId })],
			}
		},
		ClickedCopyPermalink: ({ copyId, path }) => {
			const started = startCopy(model, copyId)
			return {
				model: started.model,
				commands: [WritePermalinkClipboard({ path, generation: started.generation, copyId })],
			}
		},
		SucceededCopy: ({ generation, copyId }) => ({
			...settled(model, generation, "copied"),
			outMessage: OutMessage.Copied({ label: COPY_LABELS.get(copyId), isOk: true }),
		}),
		FailedCopy: ({ generation, copyId }) => ({
			...settled(model, generation, "error"),
			outMessage: OutMessage.Copied({ label: COPY_LABELS.get(copyId), isOk: false }),
		}),
		ElapsedCopyStatus: ({ generation }) =>
			generation === model.copy.generation
				? { model: { ...model, copy: { ...model.copy, status: "idle" } } }
				: { model },
	})

/** The status a copy control with this id shows. */
export const copyStatusOf = (model: Model, id: string): CopyStatus =>
	model.copy.id === id ? model.copy.status : "idle"
