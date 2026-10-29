import { Schema } from "effect"
import { Block } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { ComboboxBlock } from "../../ui/combobox-view"
import { DialogBlock } from "../../ui/dialog-view"

// The command palette: mounted while open, so
// the Model exists only then, and a close drops it without an exit transition.

export const PALETTE_ID = "command-palette"

export const Model = Schema.Struct({
	dialog: DialogBlock.Model,
	list: ComboboxBlock.Model,
	/** `getTracesFacetValuesResultAtom({ data: { facet: "service" } })`; empty until it answers. */
	serviceNames: Schema.Array(Schema.String),
	/** An action opened another overlay; the palette goes once focus has moved there. */
	isClosing: Schema.Boolean,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	/** A click on an entry; a link's own click also navigates (the root routes it). */
	ClickedEntry: { id: Schema.String },
	SucceededLoadServices: { serviceNames: Schema.Array(Schema.String) },
	FailedLoadServices: {},
	ElapsedCloseDelay: {},
	CompletedMeasureList: {},
	/** Operation: an action opened another overlay; the palette closes a few frames later. */
	RequestedDelayedClose: {},
})
export type Message = typeof Message.Type

/** What the palette asks of the shell, which resolves an entry id against its own entries. */
export const OutMessage = defineMessageUnion({
	Closed: {},
	/** Enter on the highlighted entry. */
	PickedEntry: { id: Schema.String },
	ClickedEntry: { id: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

export const PaletteDefinition = Block.makeDefinition("CommandPalette", { Model, Message, OutMessage })
