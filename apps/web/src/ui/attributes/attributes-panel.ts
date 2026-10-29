import { Duration, Effect, Layer, Option, Record, Schema } from "effect"
import { Block } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { CopyStatus } from "../copy-button"

// The log attributes panel's state: the attribute
// search, which collapsibles (namespace groups, JSON values, "Maple internal") are open, and the
// status of the last copy. What the panel shows comes in as view inputs. The completed
// `AttributesPanelBlock` lives in attributes-panel-block.ts.

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

export const AttributesPanelDefinition = Block.makeDefinition("AttributesPanel", { Model, Message, OutMessage })

export const WriteAttributeClipboard = AttributesPanelDefinition.makeCommand("WriteAttributeClipboard", {
	args: { text: Schema.String, generation: Schema.Number },
	messages: [Message.SucceededCopy, Message.FailedCopy],
	handler: function* () {
		return ({ text, generation }) =>
			Effect.tryPromise(() => navigator.clipboard.writeText(text)).pipe(
				Effect.as(Message.SucceededCopy({ generation })),
				Effect.orElseSucceed(() => Message.FailedCopy({ generation })),
			)
	},
})

export const WaitAttributeCopyStatus = AttributesPanelDefinition.makeCommand("WaitAttributeCopyStatus", {
	args: { generation: Schema.Number },
	messages: [Message.ElapsedCopyStatus],
	handler: function* () {
		return ({ generation }) =>
			Effect.sleep(COPY_TIMEOUT).pipe(Effect.as(Message.ElapsedCopyStatus({ generation })))
	},
})

export const EffectsLayer = Layer.mergeAll(WriteAttributeClipboard.layer, WaitAttributeCopyStatus.layer)

export const AttributesPanelComposition = AttributesPanelDefinition.makeComposition()

/** The builder every attributes view helper renders with. */
export type AttributesPanelViewBuilder = Block.ViewBuilderFor<typeof AttributesPanelComposition>
