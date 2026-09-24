import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { Clock, Effect, Schema } from "effect"
import { UpdateDashboardOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import { DashboardDocument, DashboardId, PortableDashboardDocument } from "@maple/domain/http"
import { IsoDateTimeString } from "@maple/domain"
import { validateDashboardTimeRange } from "../lib/resolve-dashboard-time-range"
import { MAX_QUERY_RANGE_SECONDS, formatRangeSeconds } from "@maple/query-engine"
import { collectDocumentRenderWarnings } from "../lib/validate-widget-renderability"
import {
	dashboardNotFound,
	toMcpDashboardError,
	optionalJsonText,
	toDashboardRow,
} from "../lib/dashboard-mutations"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const TOOL = "update_dashboard"

const decodeIsoDateTimeString = Schema.decodeUnknownSync(IsoDateTimeString)
const decodeDashboardId = Schema.decodeUnknownEffect(DashboardId)

export function registerUpdateDashboardTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		description:
			"Update an existing dashboard's top-level metadata (name, description, time_range). For widget-level changes prefer the incremental tools: add_dashboard_widget, update_dashboard_widget, remove_dashboard_widget, reorder_dashboard_widgets — they do not require re-sending the whole dashboard. `dashboard_json` is still accepted as an escape hatch for full replacement but is expensive on large dashboards and easy to corrupt.",
		parameters: Schema.Struct({
			dashboard_id: P.text("ID of the dashboard to update (use list_dashboards to find IDs)"),
			name: P.optionalText("New dashboard name"),
			description: P.optionalText("New dashboard description"),
			time_range: P.optionalText(
				`New time range as relative shorthand — e.g. 15m, 6h, 24h, 7d, 2w, 3mo, or "today". Up to ${formatRangeSeconds(MAX_QUERY_RANGE_SECONDS)}.`,
			),
			dashboard_json: optionalJsonText(
				PortableDashboardDocument,
				"Full dashboard JSON to replace the current configuration. Use get_dashboard to see the current schema.",
			),
		}),
		output: UpdateDashboardOutput,
		// `dashboard_json` overwrites every widget: the same call cannot be undone.
		hints: { readOnly: false, destructive: true, idempotent: true },
		phrases: ["Updating a dashboard"],
		handler: Effect.fn("McpTool.updateDashboard")(function* ({
			dashboard_id,
			name,
			description,
			time_range,
			dashboard_json: portable,
		}) {
			if (time_range) {
				const timeRangeError = validateDashboardTimeRange(time_range)
				if (timeRangeError) {
					return yield* new McpInvalidInputError({
						message: timeRangeError,
						parameter: "time_range",
					})
				}
			}

			const tenant = yield* CurrentMcpTenant
			const persistence = yield* DashboardPersistenceService

			const dashboardIdBranded = yield* decodeDashboardId(dashboard_id).pipe(
				Effect.mapError(() => dashboardNotFound(dashboard_id)),
			)

			const nowMillis = yield* Clock.currentTimeMillis
			const now = decodeIsoDateTimeString(new Date(nowMillis).toISOString())

			const dashboard = yield* persistence
				.mutate(tenant.orgId, tenant.userId, dashboardIdBranded, (existing) =>
					Effect.sync(() => {
						// `description`/`tags` are `Schema.optionalKey` on `DashboardDocument`: the
						// constructor rejects a present `undefined`, so omit the key instead.
						if (portable) {
							return new DashboardDocument({
								id: existing.id,
								name: portable.name,
								...(portable.description !== undefined && {
									description: portable.description,
								}),
								...(portable.tags !== undefined && { tags: portable.tags }),
								timeRange: portable.timeRange,
								widgets: portable.widgets,
								createdAt: existing.createdAt,
								updatedAt: now,
							})
						}

						const timeRange = time_range
							? {
									type: "relative" as const,
									value: time_range,
								}
							: existing.timeRange

						const nextDescription = description ?? existing.description

						return new DashboardDocument({
							id: existing.id,
							name: name ?? existing.name,
							...(nextDescription !== undefined && { description: nextDescription }),
							...(existing.tags !== undefined && { tags: existing.tags }),
							timeRange,
							widgets: existing.widgets,
							createdAt: existing.createdAt,
							updatedAt: now,
						})
					}),
				)
				.pipe(Effect.mapError(toMcpDashboardError(TOOL)))

			return {
				dashboard: toDashboardRow(dashboard),
				replaced: portable !== undefined,
				// Advisory only. This tool is the full-replacement / restore escape hatch, so a
				// legacy board carrying an ungrouped pie or a `"GB"` unit must still round-trip.
				renderWarnings: collectDocumentRenderWarnings(dashboard.widgets),
			}
		}),
		render: (output) => ({
			title: "Dashboard Updated",
			blocks: [
				doc.fields([
					["ID", output.dashboard.id],
					["Name", output.dashboard.name],
					["Description", output.dashboard.description],
					["Widgets", output.dashboard.widgetCount],
					["Updated", output.dashboard.updatedAt.slice(0, 19)],
				]),
				...(output.renderWarnings.length > 0
					? [doc.heading("Render warnings (saved anyway)"), doc.list(output.renderWarnings)]
					: []),
			],
		}),
	})
}
