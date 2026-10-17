import { Duration, Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import * as AttributesPanel from "../../../ui/attributes/attributes-panel"
import type { CopyStatus } from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import type { LogRecord } from "../../../ui/logs/log-row-view"
import * as Tabs from "../../../ui/tabs"
import { tabValues } from "./derive"
import { Message, type Model, OutMessage } from "./model"

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage>

const COPY_TIMEOUT = Duration.millis(2000)

export const WriteDetailClipboard = Command.define("WriteDetailClipboard", {
	args: { text: Schema.String, generation: Schema.Number },
	messages: [Message.SucceededCopy, Message.FailedCopy],
	execute: ({ text, generation }) =>
		Effect.tryPromise(() => navigator.clipboard.writeText(text)).pipe(
			Effect.as(Message.SucceededCopy({ generation })),
			Effect.orElseSucceed(() => Message.FailedCopy({ generation })),
		),
})

/** `logPermalink`: the origin is read when copying, never in the view. */
export const WritePermalinkClipboard = Command.define("WritePermalinkClipboard", {
	args: { logKey: Schema.String, generation: Schema.Number },
	messages: [Message.SucceededCopy, Message.FailedCopy],
	execute: ({ logKey, generation }) =>
		Effect.tryPromise(() =>
			navigator.clipboard.writeText(`${window.location.origin}/logs/${logKey}`),
		).pipe(
			Effect.as(Message.SucceededCopy({ generation })),
			Effect.orElseSucceed(() => Message.FailedCopy({ generation })),
		),
})

export const WaitDetailCopyStatus = Command.define("WaitDetailCopyStatus", {
	args: { generation: Schema.Number },
	messages: [Message.ElapsedCopyStatus],
	execute: ({ generation }) =>
		Effect.sleep(COPY_TIMEOUT).pipe(Effect.as(Message.ElapsedCopyStatus({ generation }))),
})

const TABS_ID_BASE = 900

export const init = (id: string): Model => ({
	id,
	dialog: Dialog.init(id, "sheet"),
	log: null,
	tabs: Tabs.init({ idBase: TABS_ID_BASE, values: ["attributes"], selected: "attributes" }),
	attributes: AttributesPanel.init(`${id}-attributes`),
	isHeroExpanded: false,
	copy: { id: "", status: "idle", generation: 0 },
})

const liftDialog = (model: Model, result: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, dialog: result.model },
	commands: Command.mapMessages(result.commands ?? [], (message) => Message.GotDialogMessage({ message })),
	outMessage: result.outMessage?._tag === "Closed" ? OutMessage.Closed() : undefined,
})

/** Shows `log`, starting fresh on the Attributes tab (legacy remounts the panels per log). */
export const open = (model: Model, log: LogRecord): Return =>
	liftDialog(
		{
			...model,
			log,
			tabs: Tabs.init({ idBase: TABS_ID_BASE, values: tabValues(log), selected: "attributes" }),
			attributes: AttributesPanel.init(`${model.id}-attributes`),
			isHeroExpanded: false,
		},
		Dialog.open(model.dialog),
	)

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
			return {
				model: { ...model, tabs: next.model },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotTabsMessage({ message: m }),
				),
			}
		},
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
		ClickedShowFullMessage: () => ({ model: { ...model, isHeroExpanded: !model.isHeroExpanded } }),
		ClickedCopy: ({ copyId, text }) => {
			const started = startCopy(model, copyId)
			return {
				model: started.model,
				commands: [WriteDetailClipboard({ text, generation: started.generation })],
			}
		},
		ClickedCopyPermalink: ({ copyId, logKey }) => {
			const started = startCopy(model, copyId)
			return {
				model: started.model,
				commands: [WritePermalinkClipboard({ logKey, generation: started.generation })],
			}
		},
		SucceededCopy: ({ generation }) => settled(model, generation, "copied"),
		FailedCopy: ({ generation }) => settled(model, generation, "error"),
		ElapsedCopyStatus: ({ generation }) =>
			generation === model.copy.generation
				? { model: { ...model, copy: { ...model.copy, status: "idle" } } }
				: { model },
	})

/** The status a copy control with this id shows. */
export const copyStatusOf = (model: Model, id: string): CopyStatus =>
	model.copy.id === id ? model.copy.status : "idle"
