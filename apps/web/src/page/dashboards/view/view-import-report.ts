import type { DashboardDocument } from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import { Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertAction, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { button } from "@maple/views/ui/button"
import { icon } from "@maple/views/ui/icon"
import { dividedList } from "@maple/views/ui/rule"
import { typography } from "@maple/views/ui/typography"
import { Message } from "./message"

type H = HtmlBuilder<Message>

const SOURCE_LABEL = { grafana: "Grafana" } as const

/** "Imported from Grafana: N items need attention", expanding to the list, until dismissed. */
export const importReportNotice = (
	h: H,
	document: DashboardDocument,
	options: Readonly<{ isOpen: boolean; canDismiss: boolean }>,
): ReadonlyArray<Html> => {
	const report = document.importReport
	if (report === undefined || report.items.length === 0) return []
	const count = report.items.length
	const needs = count === 1 ? "needs" : "need"
	const listId = "dashboard-import-report-items"
	return [
		alert(h, { variant: "warn", size: "sm", role: "status", className: "mb-4" }, [
			icon(h, "CircleWarningIcon"),
			alertTitle(h, [
				`Imported from ${SOURCE_LABEL[report.source]}: ${countLabel(count, "item")} ${needs} attention`,
			]),
			...(options.isOpen
				? [
						alertDescription(h, [
							dividedList(
								h,
								{
									as: "ul",
									bordered: false,
									className: "mt-1 max-h-72 overflow-y-auto",
									attributes: [h.Id(listId)],
								},
								Arr.map(report.items, (item) =>
									h.li(
										[h.Class("py-2 last:pb-0")],
										[typography(h, { size: "sm", tone: "muted" }, [item])],
									),
								),
							),
						]),
					]
				: []),
			alertAction(
				h,
				[
					button(
						h,
						{
							size: "sm",
							variant: "ghost",
							attributes: [
								h.OnClick(Message.ToggledImportReport()),
								h.AriaExpanded(options.isOpen),
								h.AriaControls(listId),
							],
						},
						[options.isOpen ? "Hide" : "Show"],
					),
					...(options.canDismiss
						? [
								button(
									h,
									{
										size: "sm",
										variant: "outline",
										attributes: [h.OnClick(Message.ClickedDismissImportReport())],
									},
									["Dismiss"],
								),
							]
						: []),
				],
				// Stays by the title when the list opens below it.
				"sm:self-start",
			),
		]),
	]
}
