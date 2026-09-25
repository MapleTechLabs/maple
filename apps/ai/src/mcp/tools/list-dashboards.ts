import type { McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { ListDashboardsOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import { DASHBOARD_TEMPLATES } from "@maple/backend/dashboard-templates"
import { toMcpDashboardError, toDashboardRow } from "../lib/dashboard-mutations"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const TOOL = "list_dashboards"

export function registerListDashboardsTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		description:
			"List all dashboards with widget counts and timestamps. Use get_dashboard to see full widget configuration.",
		parameters: Schema.Struct({
			search: P.optionalText("Filter dashboards by name (case-insensitive contains)"),
		}),
		output: ListDashboardsOutput,
		hints: { readOnly: true },
		phrases: ["Listing dashboards"],
		handler: Effect.fn("McpTool.listDashboards")(function* ({ search }) {
			const tenant = yield* CurrentMcpTenant
			const persistence = yield* DashboardPersistenceService

			const result = yield* persistence
				.list(tenant.orgId)
				.pipe(Effect.mapError(toMcpDashboardError(TOOL)))

			const lowerSearch = search?.toLowerCase()
			const dashboards =
				lowerSearch === undefined
					? result.dashboards
					: result.dashboards.filter((d) => d.name.toLowerCase().includes(lowerSearch))

			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				search: search ?? "none",
				"result.rowCount": dashboards.length,
			})

			return {
				dashboards: dashboards.map(toDashboardRow),
				total: dashboards.length,
				...(search === undefined ? undefined : { search }),
			}
		}),
		render: (output) => {
			// Interpolated rather than hardcoded: this used to suggest `service_health`, but
			// template keys are kebab-case, so the suggestion errored when followed literally.
			const exampleTemplate = DASHBOARD_TEMPLATES[0]?.id ?? "blank"
			return {
				title: "Dashboards",
				scope: [["Name contains", output.search]],
				...(output.dashboards.length === 0
					? {
							empty: {
								message:
									output.search === undefined
										? "No dashboards found."
										: `No dashboards found with a name containing "${output.search}".`,
								...(output.search === undefined
									? undefined
									: { hints: ["Drop `search` to list every dashboard."] }),
							},
						}
					: undefined),
				blocks:
					output.dashboards.length === 0
						? []
						: [
								doc.text(`Total: ${output.total} dashboard${output.total !== 1 ? "s" : ""}`),
								doc.table(
									["ID", "Name", "Widgets", "Updated"],
									output.dashboards.map((d) => [
										d.id,
										d.name,
										String(d.widgetCount),
										d.updatedAt.slice(0, 19),
									]),
								),
							],
				next: [
					...output.dashboards
						.slice(0, 3)
						.map((d) =>
							doc.next("get_dashboard", { dashboard_id: d.id }, "view dashboard configuration"),
						),
					doc.next(
						"create_dashboard",
						{ name: "New dashboard", template: exampleTemplate },
						"create a new dashboard from template",
					),
				],
			}
		},
	})
}
