import type { McpToolRegistrar } from "./types"
import { createEscalationChainAction } from "./create-escalation-chain"
import { updateEscalationChainAction } from "./update-escalation-chain"
import { deleteEscalationChainAction } from "./delete-escalation-chain"

export function registerEscalationChainTools(server: McpToolRegistrar) {
	const family = server.family({
		name: "manage_escalation_chain",
		title: "Manage Escalation Chain",
		description:
			"Create, change or delete an escalation chain: who an alert notifies, step by step, until someone acknowledges it.",
		phrases: ["Managing an escalation chain"],
	})
	createEscalationChainAction(family)
	updateEscalationChainAction(family)
	deleteEscalationChainAction(family)
}
