import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LogRowView } from "./log-row-view"

/** A rendered row of the virtual window: which log, and where it sits in the list. */
export const VirtualRow = Schema.Struct({ index: Schema.Number, start: Schema.Number })
export type VirtualRow = typeof VirtualRow.Type

export const NavigationKey = Schema.Literals(["Next", "Previous", "Open", "Expand", "Collapse", "Clear"])
export type NavigationKey = typeof NavigationKey.Type

export const Message = defineMessageUnion({
	/** The virtualizer's window moved or a row was measured. */
	ChangedVirtualWindow: { rows: Schema.Array(VirtualRow), totalSize: Schema.Number },
	/** The scroller left the newest rows, or came back to them. */
	ChangedScrolledAway: { isScrolledAway: Schema.Boolean },
	EnteredStream: {},
	LeftStream: {},
	ClickedRow: { index: Schema.Number },
	ClickedExpand: { index: Schema.Number },
	ClickedCopyMessage: { index: Schema.Number },
	ClickedCopyLink: { index: Schema.Number },
	PressedNavigationKey: { key: NavigationKey },
	EnteredChip: { index: Schema.Number, key: Schema.String },
	LeftChip: { index: Schema.Number, key: Schema.String },
	FocusedChip: { index: Schema.Number, key: Schema.String },
	BlurredChip: { index: Schema.Number, key: Schema.String },
	ClickedChip: { index: Schema.Number, key: Schema.String },
	PressedChipEscape: { index: Schema.Number, key: Schema.String },
	EnteredChipCard: {},
	LeftChipCard: {},
	ClickedChipFilter: { negated: Schema.Boolean },
	ClickedCardCopy: { part: Schema.Literals(["key", "value"]) },
	PlacedChipCard: {},
	/** A chip open or close delay ran out; `generation` drops the ones a later event superseded. */
	ElapsedChipDelay: { generation: Schema.Number },
	CompletedCopy: {},
	/** The expanded body's Details action and its JSON copy (status tracked like `useCopy`). */
	ClickedDetails: { index: Schema.Number },
	ClickedCopyJson: { index: Schema.Number },
	SucceededCopyJson: { generation: Schema.Number },
	FailedCopyJson: { generation: Schema.Number },
	ElapsedCopyJsonStatus: { generation: Schema.Number },
	CompletedScroll: {},
	/** The parent derived the same logs again (a pinned column or the search changed). */
	InformedOfRows: { rows: Schema.Array(LogRowView) },
	/** The parent has new data (a reload that prepends rows, a filter): expansion goes with the old rows. */
	InformedOfReplacedRows: { rows: Schema.Array(LogRowView) },
	/** "Jump to latest": back to the newest rows, every row collapsed. */
	RequestedJumpToLatest: {},
})
export type Message = typeof Message.Type
