import { Duration, Effect, Option, Record, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { CopyStatus } from "../copy-button"

// The log attributes panel's state: the attribute
// search, which collapsibles (namespace groups, JSON values, "Maple internal") are open, and the
// status of the last copy. What the panel shows comes in as view inputs.

export const AttributeSource = Schema.Literals(["log", "resource"])
export type AttributeSource = typeof AttributeSource.Type

export const CopyState = Schema.Struct({ id: Schema.String, status: CopyStatus, generation: Schema.Number })

export const Model = Schema.Struct({
	id: Schema.String,
	search: Schema.String,
	/** Toggled collapsibles by key; one never toggled shows its default. */
	open: Schema.Record(Schema.String, Schema.Boolean),
	copy: CopyState,
})
export type Model = typeof Model.Type

export const init = (id: string): Model => ({
	id,
	search: "",
	open: {},
	copy: { id: "", status: "idle", generation: 0 },
})

/** A collapsible's open state: toggled, else its default. */
export const isOpen = (model: Model, key: string, defaultOpen: boolean): boolean =>
	Option.getOrElse(Record.get(model.open, key), () => defaultOpen)

/** The copy status a control with this id shows. */
export const copyStatusOf = (model: Model, id: string): CopyStatus =>
	model.copy.id === id ? model.copy.status : "idle"

// MESSAGE

export const Message = defineMessageUnion({
	ChangedSearch: { text: Schema.String },
	ToggledCollapsible: { key: Schema.String, defaultOpen: Schema.Boolean },
	ClickedCopy: { copyId: Schema.String, text: Schema.String },
	SucceededCopy: { generation: Schema.Number },
	FailedCopy: { generation: Schema.Number },
	ElapsedCopyStatus: { generation: Schema.Number },
	ClickedFilter: {
		source: AttributeSource,
		key: Schema.String,
		value: Schema.String,
		negated: Schema.Boolean,
	},
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
	ChoseAttributeFilter: {
		source: AttributeSource,
		key: Schema.String,
		value: Schema.String,
		negated: Schema.Boolean,
	},
})
export type OutMessage = typeof OutMessage.Type

// COMMAND

const COPY_TIMEOUT = Duration.millis(2000)

export const WriteAttributeClipboard = Command.define("WriteAttributeClipboard", {
	args: { text: Schema.String, generation: Schema.Number },
	messages: [Message.SucceededCopy, Message.FailedCopy],
	execute: ({ text, generation }) =>
		Effect.tryPromise(() => navigator.clipboard.writeText(text)).pipe(
			Effect.as(Message.SucceededCopy({ generation })),
			Effect.orElseSucceed(() => Message.FailedCopy({ generation })),
		),
})

export const WaitAttributeCopyStatus = Command.define("WaitAttributeCopyStatus", {
	args: { generation: Schema.Number },
	messages: [Message.ElapsedCopyStatus],
	execute: ({ generation }) =>
		Effect.sleep(COPY_TIMEOUT).pipe(Effect.as(Message.ElapsedCopyStatus({ generation }))),
})

// UPDATE

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage>

const settled = (model: Model, generation: number, status: CopyStatus): Return =>
	generation === model.copy.generation
		? {
				model: modifyFields(model, { copy: (copy) => ({ ...copy, status }) }),
				commands: [WaitAttributeCopyStatus({ generation })],
			}
		: { model }

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		ChangedSearch: ({ text }) => ({ model: modifyFields(model, { search: () => text }) }),
		ToggledCollapsible: ({ key, defaultOpen }) => ({
			model: modifyFields(model, {
				open: (open) => Record.set(open, key, !isOpen(model, key, defaultOpen)),
			}),
		}),
		ClickedCopy: ({ copyId, text }) => {
			const generation = model.copy.generation + 1
			return {
				model: modifyFields(model, {
					copy: () => ({ id: copyId, status: "idle" as const, generation }),
				}),
				commands: [WriteAttributeClipboard({ text, generation })],
			}
		},
		SucceededCopy: ({ generation }) => settled(model, generation, "copied"),
		FailedCopy: ({ generation }) => settled(model, generation, "error"),
		ElapsedCopyStatus: ({ generation }) =>
			generation === model.copy.generation
				? { model: modifyFields(model, { copy: (copy) => ({ ...copy, status: "idle" as const }) }) }
				: { model },
		ClickedFilter: ({ source, key, value, negated }) => ({
			model,
			outMessage: OutMessage.ChoseAttributeFilter({ source, key, value, negated }),
		}),
	})
