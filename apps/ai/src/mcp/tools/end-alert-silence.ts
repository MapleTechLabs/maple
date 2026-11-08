import type { McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { AlertSilenceMutationOutput } from "@maple/domain/mcp-outputs"
import { AlertSilencesService } from "@maple/backend/services/alerts/AlertSilencesService"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { silenceFields, endSilenceErrors, toAlertSilenceRow } from "../lib/alert-silences"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

export function registerEndAlertSilenceTool(server: McpToolRegistrar) {
	server.define({
		name: "end_alert_silence",
		title: "End Alert Silence",
		description:
			"End an alert silence now so notifications resume; a scheduled one is cancelled. Ids from list_alert_silences.",
		parameters: Schema.Struct({
			silence_id: P.resourceId("alertSilence", "Silence to end"),
		}),
		output: AlertSilenceMutationOutput,
		hints: { readOnly: false, destructive: false, idempotent: true },
		phrases: ["Ending an alert silence"],
		handler: Effect.fn("McpTool.endAlertSilence")(function* (params) {
			const silenceId = yield* P.decodeResourceId("alertSilence", "silence_id")(params.silence_id)
			const tenant = yield* CurrentMcpTenant
			const silences = yield* AlertSilencesService
			const silence = yield* silences
				.end(tenant.orgId, tenant.userId, tenant.roles, silenceId)
				.pipe(Effect.catchTags(endSilenceErrors))
			return { silence: toAlertSilenceRow(silence) }
		}),
		render: (output) => ({
			title: "Alert Silence Ended",
			blocks: [silenceFields(output.silence)],
			next: [doc.next("list_alert_silences", {}, "the silences still active or scheduled")],
		}),
	})
}
