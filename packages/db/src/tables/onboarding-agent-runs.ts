import * as PG from "@maple-dev/effect-orm/postgres"
import { ApiKeyId, OrgId, UserId } from "@maple/primitives"
import { OnboardingAgentRunStatus, OnboardingAgentStageRecord } from "@maple/domain/onboarding-agent-run"
import { Schema } from "effect"

/** A coding agent's onboarding run: started when the prompt is copied, reported by the agent. */
export const OnboardingAgentRuns = PG.table("onboarding_agent_runs", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		userId: PG.column(PG.brand(PG.text, UserId), { name: "user_id" }),
		status: PG.brand(PG.text, OnboardingAgentRunStatus),
		stages: PG.jsonb(Schema.Array(OnboardingAgentStageRecord)),
		serviceNames: PG.column(PG.jsonb(Schema.Array(Schema.String)), { name: "service_names" }),
		traceId: PG.column(PG.nullable(PG.text), { name: "trace_id" }),
		/** The handoff code's lookup hash: the claim that mints the agent's CLI key finds the run by it. */
		handoffCodeHash: PG.column(PG.nullable(PG.text), { name: "handoff_code_hash" }),
		/** The CLI key the handoff minted. A report made with an API key only reaches that key's run. */
		apiKeyId: PG.column(PG.nullable(PG.brand(PG.text, ApiKeyId)), { name: "api_key_id" }),
		lastReportedAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_reported_at" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		expiresAt: PG.column(PG.timestamptzMillis, { name: "expires_at" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.index("onboarding_agent_runs_org_user_created_idx", ["orgId", "userId", "createdAt"]),
		PG.uniqueIndex("onboarding_agent_runs_handoff_code_hash_unq", ["handoffCodeHash"]),
		PG.index("onboarding_agent_runs_org_api_key_idx", ["orgId", "apiKeyId"]),
	],
	tenantColumn: "orgId",
})

export type OnboardingAgentRunRow = PG.SelectRowOf<typeof OnboardingAgentRuns>
