import { HttpApiBuilder } from "effect/http-api"
import { MapleInternalApi } from "@maple/domain/http"
import { SecurityAuditAccess } from "../services/security-audit/SecurityAuditAccess"
import { Effect } from "effect"

// The Security Center's audit reads, served by the api Worker rather than forwarded to ai: api stays
// warm, and ai's cold start cost most page loads a second. Writes still go to ai (`forwardsToAi`).
export const HttpSecurityAuditReadsLive = HttpApiBuilder.group(
	MapleInternalApi,
	"securityAuditReads",
	(handlers) =>
		Effect.gen(function* () {
			const audits = yield* SecurityAuditAccess
			return handlers
				.handle("listTargets", () => audits.listTargets)
				.handle("listRuns", ({ query }) => audits.listRuns(query))
				.handle("getRun", ({ params }) => audits.getRun(params.runId))
				.handle("listRunUnits", ({ params }) => audits.listRunUnits(params.runId))
				.handle("listRunEvents", ({ params, query }) => audits.listRunEvents(params.runId, query))
				.handle("listRunFindings", ({ params }) => audits.listRunFindings(params.runId))
				.handle("listFindings", ({ params, query }) => audits.listFindings(params.targetId, query))
		}),
)
