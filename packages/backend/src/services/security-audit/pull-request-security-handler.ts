import { MapleAiApi, type PullRequestEventJob } from "@maple/domain/http"
import type { OrgId } from "@maple/primitives"
import { Duration, Effect, Result, Schedule } from "effect"
import { HttpApiClient } from "effect/http-api"
import { aiWorkerConnection, MAPLE_AI_BASE_URL } from "@maple/backend/platform/ai-worker-client"
import type { AiWorkerFetcher } from "@maple/backend/platform/bindings"
import type { Env } from "@maple/backend/platform/Env"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import type { PullRequestEventHandler } from "@maple/backend/services/integrations/vcs/PullRequestEventSink"

/** Events that put new code at a pull request's head; maple-ai decides whether a target checks it. */
const FORWARDED: ReadonlySet<PullRequestEventJob["action"]> = new Set([
	"opened",
	"reopened",
	"synchronize",
	"ready_for_review",
])

/**
 * The `Maple / security` check as a consumer of the pull-request port: each push is handed to
 * maple-ai, which hosts audits. Retried, because a branch rule waits on a check nobody posts; a
 * delivery that still fails is logged and the event stands for the other handlers.
 */
export const securityPrCheckPullRequestHandler: PullRequestEventHandler<Env | AiWorkerFetcher> = Effect.gen(
	function* () {
		const connection = yield* aiWorkerConnection
		if (Result.isFailure(connection)) return { onPullRequestEvent: () => Effect.void }
		const { authorization, httpClient } = connection.success
		const client = yield* HttpApiClient.group(MapleAiApi, {
			group: "securityPrCheck",
			httpClient,
			baseUrl: MAPLE_AI_BASE_URL,
		})
		return {
			onPullRequestEvent: (orgId: OrgId, job: PullRequestEventJob) =>
				!FORWARDED.has(job.action) || job.deferredReview === true || job.headSha === undefined
					? Effect.void
					: client.pullRequest({ headers: { authorization }, payload: { orgId, job } }).pipe(
							Effect.timeout(Duration.seconds(30)),
							Effect.retry({ times: 2, schedule: Schedule.exponential("1 second") }),
							Effect.flatMap((answer) =>
								Effect.annotateCurrentSpan({
									"maple.security_pr_check.outcome": answer.outcome,
									...(answer.reason === undefined
										? undefined
										: { "maple.security_pr_check.reason": answer.reason }),
								}),
							),
							Effect.catchCause((cause) =>
								Effect.logError(
									"[SecurityPrCheck] could not hand the pull request to maple-ai",
								).pipe(
									Effect.annotateLogs({
										orgId,
										repoFullName: job.repoFullName,
										number: job.number,
										cause: summarizeCause(cause),
									}),
								),
							),
							Effect.withSpan("SecurityPrCheck.forward", {
								attributes: { orgId, "vcs.pull_request.number": job.number },
							}),
						),
		}
	},
)
