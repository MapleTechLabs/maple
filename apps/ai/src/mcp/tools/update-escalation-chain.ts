import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { EscalationChainUpdateRequest } from "@maple/domain/http"
import { EscalationChainMutationOutput } from "@maple/domain/mcp-outputs"
import { EscalationChainsService } from "@maple/backend/services/alerts/EscalationChainsService"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import {
	chainBlocks,
	invalidChainRequest,
	StepsInput,
	stepsParameterDescription,
	toEscalationChainRow,
	targetDirectory,
	toStepsRequest,
	updateChainErrors,
} from "../lib/escalation-chains"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const decodeUpdateRequest = Schema.decodeUnknownEffect(EscalationChainUpdateRequest)

export function registerUpdateEscalationChainTool(server: McpToolRegistrar) {
	server.define({
		name: "update_escalation_chain",
		title: "Update Escalation Chain",
		description:
			"Change an escalation chain's name, steps, repeats or description. Pass only what changes; steps replaces every step. " +
			"Escalations already running finish on the steps they started with. Ids from list_escalation_chains.",
		parameters: Schema.Struct({
			chain_id: P.resourceId("escalationChain", "Escalation chain to change"),
			name: P.optionalText("New name"),
			steps: P.optionalJson(StepsInput, `Replaces every step. ${stepsParameterDescription}`),
			repeat_count: P.optionalNumber("Extra passes over the whole chain after the first, 0 to 5"),
			description: P.optionalText("New notes"),
		}),
		output: EscalationChainMutationOutput,
		hints: { readOnly: false, destructive: false, idempotent: true },
		phrases: ["Updating an escalation chain"],
		handler: Effect.fn("McpTool.updateEscalationChain")(function* (params) {
			const chainId = yield* P.decodeResourceId("escalationChain", "chain_id")(params.chain_id)
			const steps = params.steps === undefined ? undefined : yield* toStepsRequest(params.steps)
			if (
				params.name === undefined &&
				steps === undefined &&
				params.repeat_count === undefined &&
				params.description === undefined
			) {
				return yield* new McpInvalidInputError({
					message: "Nothing to change: pass name, steps, repeat_count or description.",
					parameter: "steps",
				})
			}
			const request = yield* decodeUpdateRequest({
				...(params.name === undefined ? undefined : { name: params.name }),
				...(steps === undefined ? undefined : { steps }),
				...(params.repeat_count === undefined ? undefined : { repeatCount: params.repeat_count }),
				...(params.description === undefined ? undefined : { description: params.description }),
			}).pipe(Effect.mapError(invalidChainRequest))
			const tenant = yield* CurrentMcpTenant
			const chains = yield* EscalationChainsService
			const chain = yield* chains
				.update(tenant.orgId, tenant.userId, tenant.roles, chainId, request)
				.pipe(Effect.catchTags(updateChainErrors))
			const directory = yield* targetDirectory(tenant.orgId)
			return { chain: toEscalationChainRow(chain, directory) }
		}),
		render: (output) => ({
			title: "Escalation Chain Updated",
			blocks: chainBlocks(output.chain),
			next: [doc.next("list_escalation_chains", {}, "every chain and the rules using it")],
		}),
	})
}
