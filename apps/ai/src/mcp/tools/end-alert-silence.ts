import type { McpToolFamilyBuilder } from "./types"
import { Effect, Schema } from "effect"
import { AlertSilencesService } from "@maple/backend/services/alerts/AlertSilencesService"
import { silenceFields, endSilenceErrors, toAlertSilenceRow } from "../lib/alert-silences"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

export const endAlertSilenceAction = (family: McpToolFamilyBuilder<"manage_alert_silence">) =>
	family.action("end", {
		description:
			"End an alert silence now so notifications resume; a scheduled one is cancelled. Ids from list_alert_silences.",
		parameters: Schema.Struct({
			silence_id: P.resourceId("alertSilence", "Silence to end"),
		}),
		hints: { readOnly: false, destructive: false, idempotent: true },
		permission: "alerts:manage",
		handler: Effect.fn("McpTool.endAlertSilence")(function* (params) {
			const silenceId = yield* P.decodeResourceId("alertSilence", "silence_id")(params.silence_id)
			const silences = yield* AlertSilencesService
			const silence = yield* silences.end(silenceId).pipe(Effect.catchTags(endSilenceErrors))
			return { silence: toAlertSilenceRow(silence) }
		}),
		render: (output) => ({
			title: "Alert Silence Ended",
			blocks: [silenceFields(output.silence)],
			next: [doc.next("list_alert_silences", {}, "the silences still active or scheduled")],
		}),
	})
