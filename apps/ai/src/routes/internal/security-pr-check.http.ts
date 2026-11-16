/**
 * `POST /internal/security-pr-check/pull-request`: api forwards each pull request event, and this
 * Worker, where audits run, decides whether it starts the `Maple / security` check. Reached only
 * over the service binding with the internal service token.
 */
import { MapleAiApi, SecurityPrCheckUnauthorizedError } from "@maple/domain/http"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { requireInternalServiceBearer } from "../../platform/internal-service-token"
import { startPullRequestCheck } from "../../security-audit/pr-check-start"

export const HttpSecurityPrCheckLive = HttpApiBuilder.group(MapleAiApi, "securityPrCheck", (handlers) =>
	handlers.handle("pullRequest", ({ headers, payload }) =>
		Effect.gen(function* () {
			yield* requireInternalServiceBearer(
				headers.authorization,
				(message) => new SecurityPrCheckUnauthorizedError({ message }),
			)
			return yield* startPullRequestCheck(payload.orgId, payload.job).pipe(
				// Before a target matched nothing was owed to GitHub; the delivery itself stands.
				Effect.catchCause((cause) =>
					Effect.logError("[SecurityPrCheck] pull request event failed").pipe(
						Effect.annotateLogs({ orgId: payload.orgId, cause: summarizeCause(cause) }),
						Effect.as({ outcome: "skipped" as const, reason: "error" }),
					),
				),
			)
		}).pipe(Effect.withSpan("HttpSecurityPrCheck.pullRequest")),
	),
)
