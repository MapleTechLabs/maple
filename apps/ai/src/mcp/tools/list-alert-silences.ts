import type { McpToolRegistrar } from "./types"
import { Array as Arr, Effect, Schema } from "effect"
import { ListAlertSilencesOutput } from "@maple/domain/mcp-outputs"
import { AlertSilencesService } from "@maple/backend/services/alerts/AlertSilencesService"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { toMcpHttpError } from "../lib/map-http-error"
import { ALERT_SILENCE_STATUSES, formatSilenceMatchers, toAlertSilenceRow } from "../lib/alert-silences"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const MAX_LIMIT = 200

export function registerListAlertSilencesTool(server: McpToolRegistrar) {
	server.define({
		name: "list_alert_silences",
		title: "List Alert Silences",
		description:
			"List alert silences: windows that hold back alert notifications for matching rules (incidents still open and resolve). " +
			"Defaults to active and scheduled silences; pass status=ended for past ones.",
		parameters: Schema.Struct({
			status: P.optionalOneOf(
				ALERT_SILENCE_STATUSES,
				"Only silences in this status (default: active and scheduled)",
			),
			limit: P.limit({ default: 50, max: MAX_LIMIT, noun: "silences" }),
		}),
		output: ListAlertSilencesOutput,
		hints: { readOnly: true },
		phrases: ["Listing alert silences", "Checking alert silences"],
		handler: Effect.fn("McpTool.listAlertSilences")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const silences = yield* AlertSilencesService
			const statuses =
				params.status === undefined ? (["active", "scheduled"] as const) : [params.status]

			const pages = yield* Effect.forEach(statuses, (status) =>
				silences
					.list(tenant.orgId, { status, limit: params.limit + 1 })
					.pipe(Effect.mapError(toMcpHttpError("list_alert_silences"))),
			)
			const all = Arr.flatMap(pages, (page) => page.silences)
			const shown = all.slice(0, params.limit)

			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				"maple.ai.silence_status": params.status ?? "open",
				"result.rowCount": shown.length,
			})

			return {
				silences: Arr.map(shown, toAlertSilenceRow),
				total: shown.length,
				...(params.status === undefined ? undefined : { status: params.status }),
				limit: params.limit,
				hasMore: all.length > params.limit,
			}
		}),
		render: (output) => ({
			title: "Alert Silences",
			scope: [["Status", output.status ?? "active, scheduled"]],
			...(output.silences.length === 0
				? {
						empty: {
							message:
								output.status === undefined
									? "No active or scheduled alert silences."
									: `No ${output.status} alert silences.`,
							hints: ["Create one with create_alert_silence to hold back notifications."],
						},
					}
				: undefined),
			blocks:
				output.silences.length === 0
					? []
					: [
							doc.table(
								["ID", "Status", "Reason", "Matches", "Starts", "Ends", "Created by"],
								Arr.map(output.silences, (s) => [
									s.id,
									s.status,
									s.reason,
									formatSilenceMatchers(s.matchers),
									s.startsAt,
									s.endsAt,
									s.createdBy,
								]),
							),
						],
			...(output.hasMore
				? {
						truncation: {
							shown: output.silences.length,
							noun: "silences",
							...(output.limit < MAX_LIMIT
								? {
										next: doc.next(
											"list_alert_silences",
											{ status: output.status, limit: MAX_LIMIT },
											"more silences",
										),
									}
								: undefined),
						},
					}
				: undefined),
			next: [
				...Arr.map(Arr.filter(output.silences, (s) => s.status !== "ended").slice(0, 1), (s) =>
					doc.next("end_alert_silence", { silence_id: s.id }, `end "${s.reason}" now`),
				),
				doc.next("list_alert_rules", {}, "find rule ids and tags to silence"),
			],
		}),
	})
}
