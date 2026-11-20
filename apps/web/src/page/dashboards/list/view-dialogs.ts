import type { Html, HtmlBuilder } from "foldkit/html"
import { Array as Arr } from "effect"
import { countLabel } from "@maple/ui/lib/format"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import { dividedList } from "@maple/views/ui/rule"
import { typography } from "@maple/views/ui/typography"
import { displayName } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"

type H = HtmlBuilder<Message>

/** "Delete “name”?", pending until the delete answers. */
export const deleteDialog = (h: H, model: Model): Html =>
	confirmDialog(h, {
		slotId: model.deleteDialog.id,
		model: model.deleteDialog,
		toParentMessage: (message) => Message.GotDeleteDialogMessage({ message }),
		title: ["Delete “", displayName(model.pendingDelete?.name), "”?"],
		description:
			"This dashboard belongs to the whole org: deleting it removes it for everyone, not just you. This cannot be undone. Export the JSON first if you might want it back.",
		confirmLabel: "Delete for everyone",
		isPending: model.isDeleting,
		onConfirm: Message.ClickedConfirmDelete(),
	})

/** The report's summary line; a dashboard with no panels says so instead of "0 of 0". */
export const importReportSummary = (report: {
	readonly panels: number
	readonly converted: number
}): string => {
	if (report.panels === 0) return "The dashboard has no panels to convert."
	const notes = report.panels - report.converted
	const noteText =
		notes === 1
			? " 1 panel Maple cannot run yet became a note that keeps its original queries."
			: notes > 1
				? ` ${countLabel(notes, "panel")} Maple cannot run yet became notes that keep the original queries.`
				: ""
	return `${report.converted} of ${countLabel(report.panels, "panel")} converted.${noteText}`
}

/** After a Grafana import: how many panels converted, and every warning, before opening it. */
export const importReportDialog = (h: H, model: Model): Html => {
	const report = model.importReport
	if (report === null) return h.empty
	return confirmDialog(h, {
		slotId: model.importReportDialog.id,
		model: model.importReportDialog,
		toParentMessage: (message) => Message.GotImportReportDialogMessage({ message }),
		tone: "default",
		hasIcon: false,
		title: ["Imported “", displayName(report.name), "”"],
		description: importReportSummary(report),
		children:
			report.warnings.length === 0
				? []
				: [
						dividedList(
							h,
							{ as: "ul", className: "max-h-72 overflow-y-auto" },
							Arr.map(report.warnings, (warning) =>
								h.li(
									[h.Class("px-3 py-2")],
									[typography(h, { size: "sm", tone: "muted" }, [warning])],
								),
							),
						),
						typography(h, { size: "xs", tone: "muted", as: "p", className: "mt-3" }, [
							"This list stays on the dashboard until someone dismisses it.",
						]),
					],
		cancelLabel: "Close",
		confirmLabel: "Open dashboard",
		onConfirm: Message.ClickedOpenImportedDashboard(),
	})
}
