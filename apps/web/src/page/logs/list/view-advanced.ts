import { parseLogsWhereClause } from "../../../lib/logs/advanced-filter-sync"
import type { Html, HtmlBuilder } from "foldkit/html"
import { kbd } from "@maple/views/ui/display"
import {
	ADVANCED_TEXTAREA_CLASS,
	advancedFilterDialog as kitAdvancedFilterDialog,
} from "../../kit/advanced-filter"
import { whereEditor } from "../../kit/query-builder/where-editor"
import { specOf } from "./advanced"
import { ADVANCED_FIELD_ID, ADVANCED_TEXTAREA_ID } from "./advanced-model"
import { Message } from "./message"
import type { Model } from "./model"

export const advancedFilterDialog = (h: HtmlBuilder<Message>, model: Model): Html =>
	kitAdvancedFilterDialog(h, {
		slotId: "logs-advanced-filter",
		dialog: model.advanced.dialog,
		toDialogMessage: (message) => Message.GotAdvancedDialogMessage({ message }),
		description: [
			"Write SQL-like queries to filter logs by service, severity, body or any attribute. Press ",
			kbd(h, undefined, ["Enter"]),
			" to apply.",
		],
		onSubmit: Message.SubmittedAdvanced(),
		onClear: Message.ClickedClearAdvanced(),
		editor: whereEditor(h, {
			id: ADVANCED_TEXTAREA_ID,
			value: model.advanced.draft,
			ariaLabel: "Advanced logs where clause",
			placeholder: 'service.name = "checkout" AND severity != "DEBUG"',
			rows: 8,
			className: "w-full",
			textareaClassName: ADVANCED_TEXTAREA_CLASS,
			onInput: (value) => Message.ChangedAdvancedDraft({ value }),
			autocomplete: {
				fields: model.advanced.fields,
				fieldId: ADVANCED_FIELD_ID,
				spec: specOf(model),
				toMessage: (message) => Message.GotWhereFieldMessage({ message }),
				isPortaled: true,
			},
		}),
		warnings: parseLogsWhereClause(model.advanced.draft).warnings,
	})
