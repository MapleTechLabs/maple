import type { McpToolRegistrar } from "./types"
import { Array as Arr, Effect, Schema } from "effect"
import { ListEscalationChainsOutput } from "@maple/domain/mcp-outputs"
import { EscalationChainsService } from "@maple/backend/services/alerts/EscalationChainsService"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { toMcpHttpError } from "../lib/map-http-error"
import { chainBlocks, destinationDirectory, toEscalationChainRow } from "../lib/escalation-chains"
import { doc } from "../lib/tool-doc"

export function registerListEscalationChainsTool(server: McpToolRegistrar) {
	server.define({
		name: "list_escalation_chains",
		title: "List Escalation Chains",
		description:
			"List escalation chains: ordered paging steps that notify destinations one step at a time until an incident is acknowledged or resolved. " +
			"Shows each chain's steps, repeats and the rules using it. Attach one to a rule with create_alert_rule / update_alert_rule escalation_chain_id.",
		parameters: Schema.Struct({}),
		output: ListEscalationChainsOutput,
		hints: { readOnly: true },
		phrases: ["Listing escalation chains"],
		handler: Effect.fn("McpTool.listEscalationChains")(function* () {
			const tenant = yield* CurrentMcpTenant
			const chains = yield* EscalationChainsService
			const result = yield* chains
				.list(tenant.orgId)
				.pipe(Effect.mapError(toMcpHttpError("list_escalation_chains")))
			const destinations = result.chains.length === 0 ? [] : yield* destinationDirectory(tenant.orgId)
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				"result.rowCount": result.chains.length,
			})
			return {
				chains: Arr.map(result.chains, (chain) => toEscalationChainRow(chain, destinations)),
				total: result.chains.length,
			}
		}),
		render: (output) => ({
			title: "Escalation Chains",
			...(output.chains.length === 0
				? {
						empty: {
							message:
								"No escalation chains yet. Create one with create_escalation_chain from destinations in list_alert_destinations.",
						},
					}
				: undefined),
			blocks: Arr.flatMap(output.chains, (chain) => [doc.heading(chain.name), ...chainBlocks(chain)]),
			next:
				output.chains.length === 0
					? [doc.next("list_alert_destinations", {}, "the destinations a step can notify")]
					: [doc.next("list_alert_rules", {}, "attach a chain to a rule with update_alert_rule")],
		}),
	})
}
