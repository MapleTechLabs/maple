import { Schema } from "effect"
import { Block } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import * as AttributesPanel from "../attributes/attributes-panel"
import { LogRowView } from "./log-row-view"
import { Message, VirtualRow } from "./logs-stream-message"

// MODEL

export const ChipRef = Schema.Struct({ index: Schema.Number, key: Schema.String })
export type ChipRef = typeof ChipRef.Type

/**
 * One virtualized logs stream: its rows (derived by the parent and
 * handed over with the `informRows` / `informReplacedRows` operations), the virtual window, keyboard
 * focus, expanded rows, the attribute card, and what the reader is inspecting. Rows live here rather
 * than in `viewInputs` so a render does not walk O(rows) view inputs per scroll frame.
 */
export const Model = Schema.Struct({
	id: Schema.String,
	rows: Schema.Array(LogRowView),
	window: Schema.Array(VirtualRow),
	totalSize: Schema.Number,
	focusedIndex: Schema.Option(Schema.Number),
	expandedRows: Schema.Array(Schema.Number),
	isHovering: Schema.Boolean,
	isScrolledAway: Schema.Boolean,
	/** The attribute card on screen, and the chip whose rest-to-reveal delay is running. */
	visibleChip: Schema.Option(ChipRef),
	pendingOpen: Schema.Option(Schema.Struct({ chip: ChipRef, generation: Schema.Number })),
	pendingClose: Schema.Option(Schema.Number),
	chipGeneration: Schema.Number,
	/** Each expanded row's attribute panel, by row index. */
	panels: Schema.Record(Schema.String, AttributesPanel.Model),
	/** The expanded body's JSON copy: which row, and its status. */
	jsonCopy: AttributesPanel.CopyState,
})
export type Model = typeof Model.Type

// OUT MESSAGE

export const OutMessage = defineMessageUnion({
	/** A row was clicked or opened from the keyboard. */
	OpenedLog: { index: Schema.Number },
	/** The reader started or stopped inspecting (hovering, scrolled away, a row expanded). */
	ChangedInspecting: { isInspecting: Schema.Boolean, isScrolledAway: Schema.Boolean },
	/** Filter in / out from an attribute card. */
	ChoseAttributeFilter: {
		source: Schema.Literals(["log", "resource"]),
		key: Schema.String,
		value: Schema.String,
		negated: Schema.Boolean,
	},
})
export type OutMessage = typeof OutMessage.Type

export const LogsStreamDefinition = Block.makeDefinition("LogsStream", { Model, Message, OutMessage })

export const { makeStep, makeFieldsStep, makeOutMessageStep, makeOutMessageFold } = LogsStreamDefinition
