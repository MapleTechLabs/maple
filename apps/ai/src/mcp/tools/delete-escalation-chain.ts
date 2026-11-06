import type { McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { DeleteEscalationChainOutput } from "@maple/domain/mcp-outputs"
import { EscalationChainsService } from "@maple/backend/services/alerts/EscalationChainsService"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { deleteChainErrors, updateChainErrors } from "../lib/escalation-chains"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

export function registerDeleteEscalationChainTool(server: McpToolRegistrar) {
	server.define({
		name: "delete_escalation_chain",
		title: "Delete Escalation Chain",
		description:
			"Delete an escalation chain. Refused while a rule tier still names it: detach it first with update_alert_rule escalation_chain_id=\"none\" and escalation_chain_tier naming the tier, so another tier's chain stays; a tier that pages only through the chain needs a destination before that (add_destination_ids for a one-tier rule or the warning tier; a critical tier via the rule's thresholds in the v2 API or dashboard). " +
			"Escalations already running finish. Ids from list_escalation_chains.",
		parameters: Schema.Struct({
			chain_id: P.resourceId("escalationChain", "Escalation chain to delete"),
		}),
		output: DeleteEscalationChainOutput,
		hints: { readOnly: false, destructive: true, idempotent: false },
		phrases: ["Deleting an escalation chain"],
		handler: Effect.fn("McpTool.deleteEscalationChain")(function* (params) {
			const chainId = yield* P.decodeResourceId("escalationChain", "chain_id")(params.chain_id)
			const tenant = yield* CurrentMcpTenant
			const chains = yield* EscalationChainsService
			// Read first so the reply names what was deleted.
			const chain = yield* chains.get(tenant.orgId, chainId).pipe(
				Effect.catchTags({
					"@maple/http/errors/EscalationChainNotFoundError":
						updateChainErrors["@maple/http/errors/EscalationChainNotFoundError"],
					"@maple/http/errors/AlertPersistenceError":
						deleteChainErrors["@maple/http/errors/AlertPersistenceError"],
				}),
			)
			yield* chains
				.delete(tenant.orgId, tenant.roles, chainId)
				.pipe(Effect.catchTags(deleteChainErrors))
			return { id: chain.id, name: chain.name }
		}),
		render: (output) => ({
			title: "Escalation Chain Deleted",
			blocks: [
				doc.fields([
					["ID", output.id],
					["Name", output.name],
				]),
			],
			next: [doc.next("list_escalation_chains", {}, "the remaining chains")],
		}),
	})
}
