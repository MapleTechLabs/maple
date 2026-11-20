import { OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { Array as Arr, Effect, Option, Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { PageContext } from "../../page/contract"
import { Message } from "../../page/dashboards/view/message"
import { Model } from "../../page/dashboards/view/model"
import { init as pageInit, update as pageUpdate } from "../../page/dashboards/view/update"
import { importReportNotice } from "../../page/dashboards/view/view-import-report"
import { defineLabWithFlags } from "../define"
import { keepLocal } from "../local-commands"

// `/lab/dashboard-import-notice`: the "Imported from Grafana" notice on a board (`?state=`):
// collapsed or expanded; Show / Hide work, Dismiss only sends its (dropped) write.

const LabState = Schema.Literals(["collapsed", "expanded"])
type LabState = typeof LabState.Type
const Flags = Schema.Struct({ state: LabState })
type Flags = typeof Flags.Type

const CONTEXT: PageContext = { orgId: OrgId.make("lab"), pinnedNamespace: null, timeZone: "UTC" }

const DOCUMENT = Schema.decodeSync(DashboardDocument)({
	id: "dash_lab_import",
	name: "API on AMP",
	timeRange: { type: "relative", value: "6h" },
	widgets: [],
	createdAt: "2026-11-01T12:00:00.000Z",
	updatedAt: "2026-11-18T12:00:00.000Z",
	schemaVersion: 3,
	importReport: {
		source: "grafana",
		items: [
			"Queries on the grafana-amazonprometheus-datasource datasource were imported as PromQL over Maple's metrics; check that they read the same series.",
			'Variable "route" lists values without the filters in "http_server_requests_total{env="prod", job=~"$job"}" that use other variables; Maple variables do not narrow each other yet.',
			'Variable "route" filters its values with the regex /api/.*/ in Grafana; Maple lists every value.',
			'Panel "Requests by route" applies Grafana transformations (organize); Maple shows the query result untransformed.',
			'Panel "Top handlers" has 1 field override in Grafana; Maple applies the panel\'s defaults to every series.',
		],
	},
})

const flags: Effect.Effect<Flags> = Effect.sync(() => ({
	state: Option.getOrElse(
		Schema.decodeUnknownOption(LabState)(new URLSearchParams(window.location.search).get("state")),
		(): LabState => "collapsed",
	),
}))

const update = (model: Model, message: Message) => {
	const next = pageUpdate(model, message, CONTEXT)
	return { model: next.model, commands: keepLocal(next.commands) }
}

const step = (model: Model, message: Message) => pageUpdate(model, message, CONTEXT).model

const init = (flags: Flags) => {
	const loaded = Arr.reduce(
		[
			Message.UpdatedDashboard({ orgId: CONTEXT.orgId, maybeDocument: Option.some(DOCUMENT) }),
			...(flags.state === "expanded" ? [Message.ToggledImportReport()] : []),
		],
		pageInit({ dashboardId: DOCUMENT.id, search: {} }, CONTEXT).model,
		step,
	)
	return { model: loaded, commands: [] }
}

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("bg-background p-6")],
		model.document === null
			? []
			: importReportNotice(h, model.document, { isOpen: model.isImportReportOpen, canDismiss: true }),
	)

export const lab = defineLabWithFlags("Dashboard import notice", {
	Model,
	Flags,
	flags,
	init,
	update,
	view,
	devTools: { Message },
})
