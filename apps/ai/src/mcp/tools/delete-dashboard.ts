import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { DashboardId } from "@maple/domain/http"
import { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import { CurrentMcpTenant } from "../tenant"
import { dashboardNotFound, loadDashboard, toMcpDashboardError } from "../lib/dashboard-mutations"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { toolAudit } from "../lib/tool-audit"

const TOOL = "delete_dashboard"

const decodeDashboardId = Schema.decodeUnknownEffect(DashboardId)

export function registerDeleteDashboardTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "Delete Dashboard",
		description:
			"Permanently delete a dashboard with every widget and saved version; its share links stop working. Irreversible; requires confirm=true, and only for a dashboard the user named: when they did not say which, list them and ask. To clear its widgets and keep the dashboard, use replace_dashboard_widgets. Ids from list_dashboards.",
		parameters: Schema.Struct({
			dashboard_id: P.resourceId("dashboard", "Dashboard ID (ids from list_dashboards)"),
			confirm: P.flag("Must be true. There is no undo."),
		}),
		hints: { readOnly: false, destructive: true, idempotent: false },
		permission: "dashboards:edit",
		phrases: ["Deleting a dashboard"],
		handler: Effect.fn("McpTool.deleteDashboard")(function* ({ dashboard_id, confirm }) {
			if (confirm !== true) {
				return yield* new McpInvalidInputError({
					message: `Deletion not confirmed. Re-call ${TOOL} with confirm=true to delete dashboard ${dashboard_id} for good.`,
					parameter: "confirm",
				})
			}
			const tenant = yield* CurrentMcpTenant
			const persistence = yield* DashboardPersistenceService
			// Read first: the tombstone carries no name, and the reply says what was deleted.
			const dashboard = yield* loadDashboard(dashboard_id, TOOL)
			const id = yield* decodeDashboardId(dashboard_id).pipe(
				Effect.mapError(() => dashboardNotFound(dashboard_id)),
			)
			const deleted = yield* persistence
				.delete(tenant.orgId, id)
				.pipe(Effect.mapError(toMcpDashboardError(TOOL)))
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.dashboard.id": deleted.id })
			const audit = yield* toolAudit
			yield* audit.record({
				...audit.who,
				action: "dashboard.deleted",
				resourceId: deleted.id,
				metadata: { name: dashboard.name, widgets: dashboard.widgets.length, ...audit.origin },
			})
			return {
				deleted: true,
				id: deleted.id,
				name: dashboard.name,
				widgetCount: dashboard.widgets.length,
			}
		}),
		render: (output) => ({
			title: "Dashboard deleted",
			blocks: [
				doc.text(
					`Deleted "${output.name}" (${output.id}) with its ${output.widgetCount} widget${output.widgetCount === 1 ? "" : "s"}.`,
				),
			],
			next: [doc.next("list_dashboards", {}, "the dashboards that remain")],
		}),
	})
}
