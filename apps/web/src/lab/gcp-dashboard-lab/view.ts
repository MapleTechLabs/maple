import type { DashboardDocument } from "@maple/domain/http"
import type { VariableValues } from "@maple/query-engine"
import type { Html, HtmlBuilder } from "foldkit/html"
import { ResolveThemeColors } from "../../charts/theme-colors"
import { WIDGET_CHART_TOKENS } from "../../page/dashboards/kit/chart-tokens"
import { widgetTile } from "../../page/dashboards/kit/tiles"
import * as VariablesManagerView from "../../page/dashboards/kit/variables-manager/view"
import { Message } from "../../page/dashboards/view/message"
import type { Model } from "../../page/dashboards/view/model"
import { variablesOf } from "../../page/dashboards/view/plan"
import { dashboardSections } from "../../page/dashboards/view/view-grid"
import { variableSelects } from "../../page/dashboards/view/view-variables"
import { tileContext } from "../../page/dashboards/view/view-widgets"
import { dashboardPage } from "../../page/kit/dashboard-page"
import { fixtureRows } from "./fixture"
import { CONTEXT } from "./update"

// `GcpDashboardLab`: `DashboardPage` with the variable chips as its actions, the board as
// `ReadOnlyDashboardView`, and the variables dialog.

type H = HtmlBuilder<Message>
type Widget = DashboardDocument["widgets"][number]

/** `LabWidget`: the widget's visualization over the fixture series, no actions. */
const labTile = (h: H, model: Model, widget: Widget, values: VariableValues): Html =>
	widgetTile(
		h,
		{
			...tileContext(h, model, widget, CONTEXT.timeZone, values),
			state: { _tag: "Ready", data: { _tag: "Rows", rows: fixtureRows(widget, values) } },
			menu: null,
			isMenuOpen: false,
			configure: null,
		},
		widget,
	)

/** `ReadOnlyDashboardView`: the sectioned board in the page's scroll area, with its gutter. */
const board = (h: H, model: Model, document: DashboardDocument): Html => {
	const values = variablesOf(model, CONTEXT).values
	return dashboardSections(
		h,
		{
			model,
			timeZone: CONTEXT.timeZone,
			variables: values,
			renderTile: (widget) => labTile(h, model, widget, values),
		},
		document,
	)
}

export const view = (model: Model, h: H): Html =>
	h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: WIDGET_CHART_TOKENS }))],
		[
			dashboardPage(
				h,
				{ actions: variableSelects(h, model, CONTEXT, true)[0] },
				model.document === null ? [] : [board(h, model, model.document)],
			),
			h.submodel({
				slotId: "dashboard-view-variables-manager",
				model: model.variablesManager,
				view: VariablesManagerView.view,
				viewInputs: { slotId: "dashboard-variables-dialog" },
				toParentMessage: (message) => Message.GotVariablesManagerMessage({ message }),
			}),
		],
	)
