import type { McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { EscalationChainCreateRequest } from "@maple/domain/http"
import { EscalationChainMutationOutput } from "@maple/domain/mcp-outputs"
import { EscalationChainsService } from "@maple/backend/services/alerts/EscalationChainsService"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import {
	chainBlocks,
	createChainErrors,
	invalidChainRequest,
	StepsInput,
	stepsParameterDescription,
	toEscalationChainRow,
	targetDirectory,
	toStepsRequest,
} from "../lib/escalation-chains"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const decodeCreateRequest = Schema.decodeUnknownEffect(EscalationChainCreateRequest)

export function registerCreateEscalationChainTool(server: McpToolRegistrar) {
	server.define({
		name: "create_escalation_chain",
		title: "Create Escalation Chain",
		description:
			"Create an escalation chain: steps that each page their targets (alert destinations, members by email and chat DM, or whoever is on call on a schedule), then wait for an acknowledgement before the next step. " +
			"A rule tier that names the chain still notifies its own destinations at once; the chain pages on top until the incident is acknowledged or resolved. " +
			"Attach it with create_alert_rule / update_alert_rule escalation_chain_id.",
		parameters: Schema.Struct({
			name: P.text("Chain name, e.g. 'Checkout on-call'"),
			steps: P.json(StepsInput, stepsParameterDescription),
			repeat_count: P.optionalNumber(
				"Extra passes over the whole chain after the first, 0 to 5 (default 0)",
			),
			description: P.optionalText("Free-form notes"),
		}),
		output: EscalationChainMutationOutput,
		hints: { readOnly: false, destructive: false, idempotent: false },
		phrases: ["Creating an escalation chain"],
		handler: Effect.fn("McpTool.createEscalationChain")(function* (params) {
			const steps = yield* toStepsRequest(params.steps)
			const request = yield* decodeCreateRequest({
				name: params.name,
				steps,
				...(params.repeat_count === undefined ? undefined : { repeatCount: params.repeat_count }),
				...(params.description === undefined ? undefined : { description: params.description }),
			}).pipe(Effect.mapError(invalidChainRequest))
			const tenant = yield* CurrentMcpTenant
			const chains = yield* EscalationChainsService
			const chain = yield* chains
				.create(tenant.orgId, tenant.userId, tenant.roles, request)
				.pipe(Effect.catchTags(createChainErrors))
			const directory = yield* targetDirectory(tenant.orgId)
			return { chain: toEscalationChainRow(chain, directory) }
		}),
		render: (output) => ({
			title: "Escalation Chain Created",
			blocks: chainBlocks(output.chain),
			next: [
				doc.next(
					"list_alert_rules",
					{},
					`attach it with update_alert_rule escalation_chain_id="${output.chain.id}"`,
				),
			],
		}),
	})
}
