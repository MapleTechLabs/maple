import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Combobox from "../../ui/combobox"
import * as Dialog from "../../ui/dialog"
import { PaletteAction } from "./entries"

// The command palette: mounted while open, so
// the Model exists only then, and a close drops it without an exit transition.

export const PALETTE_ID = "command-palette"

export const Model = Schema.Struct({
	dialog: Dialog.Model,
	list: Combobox.Model,
	/** `getTracesFacetValuesResultAtom({ data: { facet: "service" } })`; empty until it answers. */
	serviceNames: Schema.Array(Schema.String),
	/** An action opened another overlay; the palette goes once focus has moved there. */
	isClosing: Schema.Boolean,
})
export type Model = typeof Model.Type

export const init = (): Model => ({
	dialog: Dialog.init(PALETTE_ID, "command-dialog", { isOpen: true }),
	list: Combobox.init(`${PALETTE_ID}-list`, "autocomplete", { isOpen: true, autoHighlight: true }),
	serviceNames: [],
	isClosing: false,
})

export const Message = defineMessageUnion({
	GotDialogMessage: { message: Dialog.Message },
	GotListMessage: { message: Combobox.Message },
	/** A pick: a click on an entry or Enter on the highlighted one (`items` in list order). */
	ClickedEntry: { id: Schema.String },
	/** Enter in the input; the view knows whether the org shows Releases. */
	PressedEnter: { visibleFlagged: Schema.Array(Schema.String) },
	SucceededLoadServices: { serviceNames: Schema.Array(Schema.String) },
	FailedLoadServices: {},
	CompletedReleaseServices: {},
	ElapsedCloseDelay: {},
	CompletedMeasureList: {},
	CompletedScrollHighlighted: {},
})
export type Message = typeof Message.Type

/** What the palette asks of the shell; every one of them closes it. */
export const OutMessage = defineMessageUnion({
	Closed: {},
	Navigated: { href: Schema.String },
	RanAction: { action: PaletteAction },
})
export type OutMessage = typeof OutMessage.Type
