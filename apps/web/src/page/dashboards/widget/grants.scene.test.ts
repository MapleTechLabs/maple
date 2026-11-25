import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { DashboardDocument } from "@maple/domain/http"
import { ResolveThemeColors } from "@maple/views/charts/theme-colors"
import * as Tabs from "@maple/views/ui/tabs"
import { Option, Schema, Array as Arr, String as Str } from "effect"
import { expect as expectView, given, Mount, role, scene, withViewInputs } from "foldkit/scene"
import { describe, test } from "vitest"
import type { PageContext } from "../../contract"
import { denialTooltip } from "../../kit/session-grants"
import { MeasurePreview } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { update } from "./page-update"
import { init } from "./update"
import { topbarActions, view as pageView } from "./view"

// The widget editor asks for the permissions the API checks on its write: `dashboards:edit` to
// apply, and `query:sql` to switch a widget to Raw SQL or change a Raw SQL widget's SQL.

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const actions = withViewInputs(topbarActions, { context })()

const requestRate = {
	id: "rate",
	visualization: "chart",
	dataSource: {
		kind: "promql",
		query: "sum(rate(http_requests_total[5m]))",
		legendFormat: "",
		displayType: "line",
	},
	display: { title: "Request rate", chartId: "query-builder-line" },
	layout: { x: 0, y: 0, w: 6, h: 4 },
}

const STORED_SQL = `SELECT toStartOfInterval(Timestamp, INTERVAL $__interval_s SECOND) AS bucket,
       count() AS logs
FROM logs
WHERE $__orgFilter AND $__timeFilter(Timestamp)
GROUP BY bucket
ORDER BY bucket`

const logVolume = {
	id: "logs",
	visualization: "chart",
	dataSource: { kind: "raw_sql", sql: STORED_SQL, displayType: "line" },
	display: { title: "Log volume", chartId: "query-builder-line" },
	layout: { x: 6, y: 0, w: 6, h: 4 },
}

const document = Schema.decodeUnknownSync(DashboardDocument)({
	id: "dash_promql",
	name: "Prometheus",
	timeRange: { type: "relative", value: "1h" },
	widgets: [requestRate, logVolume],
	createdAt: "2026-09-19T12:00:00.000Z",
	updatedAt: "2026-09-28T12:00:00.000Z",
	schemaVersion: 3,
})

const openedAs = (grants: ReadonlyArray<Policy.Permission>, widgetId = "rate"): Model =>
	Arr.reduce(
		[
			Message.CompletedFetchSession({ orgId, grants }),
			Message.CompletedReadClock({ nowMs: Date.parse("2026-10-01T12:00:00Z") }),
			Message.UpdatedDashboard({ orgId, maybeDocument: Option.some(document) }),
		],
		init({ dashboardId: "dash_promql", widgetId, search: {} }, context).model,
		(model, message) => pageUpdate(model, message).model,
	)

const mounted = (model: Model) =>
	[
		given(model),
		Mount.resolve(ResolveThemeColors, Message.ResolvedThemeColors({ colors: {} })),
		Mount.resolve(MeasurePreview, Message.MeasuredPreview({ widthPx: 800 })),
		Mount.resolve<string, Tabs.Message>(
			Tabs.MeasureTabIndicator,
			Tabs.Message.MeasuredIndicator({
				rect: { left: 0, right: 225, top: 4, bottom: 5, width: 112, height: 32 },
			}),
		),
	] as const

const rawSqlTab = role("tab", { name: "Raw SQL" })

describe("widget editor and the viewer's role", () => {
	test("without query:sql the Raw SQL tab is locked with the denial and does not select", () => {
		scene(
			{ update: pageUpdate, view },
			...mounted(openedAs(["telemetry:read", "dashboards:edit"])),
			expectView(rawSqlTab).toHaveAttr("aria-disabled", "true"),
			expectView(rawSqlTab).toHaveAttr("data-tooltip", denialTooltip("query:sql")),
			expectView(role("tab", { name: "PromQL" })).toHaveAttr("aria-selected", "true"),
		)
	})

	test("with query:sql the Raw SQL tab can be picked", () => {
		scene(
			{ update: pageUpdate, view },
			...mounted(openedAs(["telemetry:read", "dashboards:edit", "query:sql"])),
			expectView(rawSqlTab).toHaveAttr("aria-disabled", "false"),
		)
	})

	test("Apply is locked for a role without dashboards:edit", () => {
		scene(
			{ update: pageUpdate, view: actions },
			given(openedAs(["telemetry:read", "query:sql"])),
			expectView(role("button", { name: "Apply" })).toBeDisabled(),
			expectView(role("group", { name: Policy.denialFor("dashboards:edit").message })).toExist(),
		)
	})

	test("without query:sql a Raw SQL widget applies as opened, but not once its SQL is edited", () => {
		const editor = ["telemetry:read", "dashboards:edit"] as const
		const edited = (grants: ReadonlyArray<Policy.Permission>) =>
			pageUpdate(
				openedAs(grants, "logs"),
				Message.ChangedSql({
					value: Str.replace("count() AS logs", "uniq(TraceId) AS logs")(STORED_SQL),
				}),
			).model
		const apply = role("button", { name: "Apply" })
		scene(
			{ update: pageUpdate, view: actions },
			given(openedAs(editor, "logs")),
			expectView(apply).toBeEnabled(),
			expectView(role("group", { name: Policy.denialFor("query:sql").message })).not.toExist(),
		)
		scene(
			{ update: pageUpdate, view: actions },
			given(edited(editor)),
			expectView(apply).toBeDisabled(),
			expectView(role("group", { name: Policy.denialFor("query:sql").message })).toHaveAttr(
				"data-tooltip",
				denialTooltip("query:sql"),
			),
		)
		scene(
			{ update: pageUpdate, view: actions },
			given(edited([...editor, "query:sql"])),
			expectView(apply).toBeEnabled(),
		)
	})
})
