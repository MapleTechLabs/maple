import { Duration, Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import * as AttributesPanel from "../../../ui/attributes/attributes-panel"
import * as InfraCorrelation from "../../kit/infra-correlation"
import type { CopyStatus } from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import type { LogRecord } from "../../../ui/logs/log-row-view"
import * as Keyed from "../../../data/keyed"
import { writeClipboard } from "../../kit/clipboard"
import type { Resources } from "../../../platform/resources"
import * as Tabs from "../../../ui/tabs"
import * as ToggleGroup from "../../../ui/toggle-group"
import { tabValues } from "./derive"
import { Message, type Model, OutMessage } from "./model"
import { requestPanels } from "./panels"

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

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
	args: { logKey: Schema.String, generation: Schema.Number, copyId: Schema.String },
	messages: [Message.SucceededCopy, Message.FailedCopy],
	execute: ({ logKey, generation, copyId }) =>
		Effect.suspend(() => writeClipboard(`${window.location.origin}/logs/${logKey}`)).pipe(
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

/** `isPage`: `/logs/$logId` shows every panel at once, outside a sheet. */
export const init = (id: string, isPage = false): Model => ({
	id,
	orgId: "",
	pinnedNamespace: null,
	isPage,
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
	infra: InfraCorrelation.init(`${id}-infra`, ""),
	isHeroExpanded: false,
	copy: { id: "", status: "idle", generation: 0 },
})

const liftDialog = (model: Model, result: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, dialog: result.model },
	commands: Command.mapMessages(result.commands ?? [], (message) => Message.GotDialogMessage({ message })),
	outMessage: result.outMessage?._tag === "Closed" ? OutMessage.Closed() : undefined,
})

/** A log on show: the attributes and context panels start fresh. */
const viewing = (model: Model, log: LogRecord, selected: string): Model => {
	const values = tabValues(log)
	const isSameTabs = model.tabs.selected === selected && values.join() === model.tabs.values.join()
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
		infra: InfraCorrelation.init(`${model.id}-infra`, model.orgId),
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

/** Shows `log`, starting fresh on the Attributes tab with new panels. */
export const open = (model: Model, log: LogRecord, scope: Scope): Return =>
	withPanels(
		liftDialog(
			viewing(
				{ ...model, orgId: scope.orgId, pinnedNamespace: scope.pinnedNamespace },
				log,
				"attributes",
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
		),
	})

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
		ClickedLog: ({ log }) => withPanels({ model: viewing(model, log, model.tabs.selected) }),
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
		GotInfraMessage: ({ message: inner }) => {
			const next = InfraCorrelation.update(model.infra, inner)
			return {
				model: { ...model, infra: next.model },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotInfraMessage({ message: m }),
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
		ClickedCopyPermalink: ({ copyId, logKey }) => {
			const started = startCopy(model, copyId)
			return {
				model: started.model,
				commands: [WritePermalinkClipboard({ logKey, generation: started.generation, copyId })],
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
