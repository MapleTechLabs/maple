import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as AttributesPanel from "../../../ui/attributes/attributes-panel"
import { CopyStatus } from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import { LogRecord } from "../../../ui/logs/log-row-view"
import * as Tabs from "../../../ui/tabs"

// `LogDetailSheet` (apps/web/src/components/logs/log-detail-sheet.tsx): the drawer for one log.

export const DetailCopy = Schema.Struct({ id: Schema.String, status: CopyStatus, generation: Schema.Number })

export const Model = Schema.Struct({
	id: Schema.String,
	dialog: Dialog.Model,
	/** The log on show; kept while the sheet animates out. */
	log: Schema.NullOr(LogRecord),
	tabs: Tabs.Model,
	/** Rebuilt per log, like legacy's `key={logKey}` remount (resets the attribute search). */
	attributes: AttributesPanel.Model,
	/** `LogHeroHeader`'s "Show full message". */
	isHeroExpanded: Schema.Boolean,
	/** The last copy from the hero or the meta strip, and its status. */
	copy: DetailCopy,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	GotDialogMessage: { message: Dialog.Message },
	GotTabsMessage: { message: Tabs.Message },
	GotAttributesMessage: { message: AttributesPanel.Message },
	ClickedShowFullMessage: {},
	ClickedCopy: { copyId: Schema.String, text: Schema.String },
	ClickedCopyPermalink: { copyId: Schema.String, logKey: Schema.String },
	SucceededCopy: { generation: Schema.Number },
	FailedCopy: { generation: Schema.Number },
	ElapsedCopyStatus: { generation: Schema.Number },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
	ChoseAttributeFilter: {
		source: AttributesPanel.AttributeSource,
		key: Schema.String,
		value: Schema.String,
		negated: Schema.Boolean,
	},
	/** The sheet closed (Close, Escape, a press outside): the stream stops holding its tail. */
	Closed: {},
})
export type OutMessage = typeof OutMessage.Type
