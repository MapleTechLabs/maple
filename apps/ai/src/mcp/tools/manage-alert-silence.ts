import type { McpToolRegistrar } from "./types"
import { createAlertSilenceAction } from "./create-alert-silence"
import { endAlertSilenceAction } from "./end-alert-silence"

export function registerAlertSilenceTools(server: McpToolRegistrar) {
	const family = server.family({
		name: "manage_alert_silence",
		title: "Manage Alert Silence",
		description:
			"Hold back alert notifications, or let them through again: create a silence for matching rules, or end one. Rules keep evaluating while silenced.",
		phrases: ["Managing an alert silence"],
	})
	createAlertSilenceAction(family)
	endAlertSilenceAction(family)
}
