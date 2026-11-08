import type { McpToolRegistrar } from "./types"
import { Array as Arr, Effect, Schema } from "effect"
import { ListMaintenanceWindowsOutput } from "@maple/domain/mcp-outputs"
import { AlertMaintenanceWindowsService } from "@maple/backend/services/alerts/AlertMaintenanceWindowsService"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { toMcpHttpError } from "../lib/map-http-error"
import { maintenanceWindowTableRow, toMaintenanceWindowRow } from "../lib/maintenance-windows"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const MAX_LIMIT = 100

export function registerListMaintenanceWindowsTool(server: McpToolRegistrar) {
	server.define({
		name: "list_maintenance_windows",
		title: "List Maintenance Windows",
		description:
			"List maintenance windows: one-off or weekly periods that silence matching alert rules and can keep their hours out of anomaly baselines. " +
			"Each occurrence shows up as an alert silence while it runs.",
		parameters: Schema.Struct({
			limit: P.limit({ default: 50, max: MAX_LIMIT, noun: "windows" }),
			offset: P.offset({ max: 1_000 }),
		}),
		output: ListMaintenanceWindowsOutput,
		hints: { readOnly: true },
		phrases: ["Listing maintenance windows", "Checking maintenance windows"],
		handler: Effect.fn("McpTool.listMaintenanceWindows")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const windows = yield* AlertMaintenanceWindowsService
			const page = yield* windows
				.list(tenant.orgId, { limit: params.limit + 1, offset: params.offset })
				.pipe(Effect.mapError(toMcpHttpError("list_maintenance_windows")))
			const shown = page.windows.slice(0, params.limit)

			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "result.rowCount": shown.length })

			return {
				windows: Arr.map(shown, toMaintenanceWindowRow),
				total: shown.length,
				limit: params.limit,
				offset: params.offset,
				hasMore: page.windows.length > shown.length,
			}
		}),
		render: (output) => ({
			title: "Maintenance Windows",
			...(output.windows.length === 0
				? {
						empty: {
							message: "No maintenance windows.",
							hints: [
								"Create one with create_maintenance_window to silence alerts on a schedule.",
							],
						},
					}
				: undefined),
			blocks:
				output.windows.length === 0
					? []
					: [
							doc.table(
								["ID", "Name", "Schedule", "Matches", "Next occurrence", "Enabled"],
								Arr.map(output.windows, maintenanceWindowTableRow),
							),
						],
			...(output.hasMore
				? {
						truncation: {
							shown: output.windows.length,
							noun: "windows",
							next: doc.next(
								"list_maintenance_windows",
								{ limit: output.limit, offset: output.offset + output.windows.length },
								"the next page",
							),
						},
					}
				: undefined),
			// Deleting is destructive, so it is never offered as a ready-made follow-up.
			next: [doc.next("list_alert_rules", {}, "find rule ids and tags a window can match")],
		}),
	})
}
