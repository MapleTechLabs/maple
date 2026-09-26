import { McpInvalidInputError, McpUnavailableError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { RegisterAgentOutput } from "@maple/domain/mcp-outputs"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"
import { persistenceFailed, validationFailed } from "./error-issue-shared"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { ErrorActorsService } from "@maple/backend/services/errors/ErrorActorsService"

export function registerRegisterAgentTool(server: McpToolRegistrar) {
	server.define({
		name: "register_agent",
		description:
			"Register an LLM agent with the error-issue system so it can claim and transition issues. Must be called from a human session (not an agent API key). Returns an actor ID to pin via API-key metadata.",
		parameters: Schema.Struct({
			name: P.text("Unique agent name within the org (1..100 chars)"),
			model: P.optionalText("Model identifier, e.g. 'claude-opus-4.7'"),
			capabilities_json: P.optionalJson(
				Schema.Array(Schema.String),
				'JSON array of capability tags, e.g. ["auto-triage","patch-proposer"]',
			),
		}),
		output: RegisterAgentOutput,
		hints: { readOnly: false, destructive: false, idempotent: false },
		phrases: ["Registering an agent"],
		handler: Effect.fn("McpTool.registerAgent")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			if (tenant.actorId) {
				return yield* new McpUnavailableError({
					message: "register_agent must be called from a human session, not an agent API key.",
					capability: "human_session",
				})
			}
			if (params.name.trim().length === 0) {
				return yield* new McpInvalidInputError({
					message: "Agent name must not be empty.",
					parameter: "name",
				})
			}

			const actors = yield* ErrorActorsService
			const actor = yield* actors
				.registerAgent(tenant.orgId, tenant.userId, {
					name: params.name,
					model: params.model,
					capabilities: params.capabilities_json ?? [],
				})
				.pipe(
					Effect.catchTags({
						"@maple/http/errors/ErrorValidationError": validationFailed("name"),
						"@maple/http/errors/ErrorPersistenceError": persistenceFailed("register_agent"),
					}),
				)

			const audit = yield* AuditLogService
			yield* audit.record({
				orgId: tenant.orgId,
				actor: { type: "user", userId: tenant.userId },
				source: "mcp",
				action: "agent.registered",
				resourceId: actor.id,
				metadata: { name: actor.agentName ?? params.name },
			})

			return {
				id: actor.id,
				agentName: actor.agentName ?? params.name,
				model: actor.model,
				capabilities: actor.capabilities,
			}
		}),
		render: (output) => ({
			title: "Agent registered",
			blocks: [
				doc.fields([
					["Actor ID", output.id],
					["Name", output.agentName ?? undefined],
					["Model", output.model ?? undefined],
					[
						"Capabilities",
						output.capabilities.length > 0 ? output.capabilities.join(", ") : undefined,
					],
				]),
				doc.text(
					`Pin this actor to an API key by storing { "agentActorId": "${output.id}" } in the key's metadata, or pass \`x-maple-agent-id: ${output.id}\` on tool requests.`,
				),
			],
		}),
	})
}
