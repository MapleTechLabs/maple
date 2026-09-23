import type { PullRequestEventJob } from "@maple/domain/http"
import type { OrgId } from "@maple/domain/primitives"
import { Context, Effect, Layer } from "effect"
import { summarizeCause } from "@maple/backend/platform/describe-cause"

/**
 * Where a pull-request webhook goes after the VCS layer has resolved its owning
 * org.
 *
 * A port rather than a direct call into the errors services, for the same reason
 * `VcsProviderClient` is one: this directory maps provider events to VCS facts
 * and knows nothing about issues, verification windows, or workflow states. The
 * sink is bound to `IssueFixVerificationService` in the composition roots, and
 * to a recording stub in tests — which is what lets the sync-service tests
 * assert "this delivery was forwarded once, with this org" without standing up
 * the whole error-issue stack.
 *
 * Failures are the sink's own business. It returns `Effect<void, never>` so a
 * problem on the issues side can never fail a webhook job and trigger a GitHub
 * redelivery of an event the VCS layer already handled correctly.
 */
export interface PullRequestEventSinkApi {
	readonly onPullRequestEvent: (orgId: OrgId, job: PullRequestEventJob) => Effect.Effect<void>
}

export class PullRequestEventSink extends Context.Service<PullRequestEventSink, PullRequestEventSinkApi>()(
	"@maple/api/services/integrations/vcs/PullRequestEventSink",
) {}

/** One consumer of the port, built in whatever services it needs. */
export type PullRequestEventHandler<R> = Effect.Effect<PullRequestEventSinkApi, never, R>

/**
 * Several consumers as one sink, each isolated from the others.
 *
 * A delivery reaches every handler even when one of them dies: the fix-verification link and the
 * review trigger are independent reads of the same event, and a defect in one is no reason for the
 * other to miss the pull request. Handlers run in order; a failure is logged with its name and the
 * delivery stands.
 */
export const pullRequestEventSinkFanout = <R>(
	handlers: ReadonlyArray<{ readonly name: string; readonly handler: PullRequestEventHandler<R> }>,
): Layer.Layer<PullRequestEventSink, never, R> =>
	Layer.effect(
		PullRequestEventSink,
		Effect.gen(function* () {
			const built = yield* Effect.forEach(handlers, ({ name, handler }) =>
				handler.pipe(Effect.map((sink) => ({ name, sink }))),
			)
			return {
				onPullRequestEvent: (orgId, job) =>
					Effect.forEach(
						built,
						({ name, sink }) =>
							sink.onPullRequestEvent(orgId, job).pipe(
								Effect.catchCause((cause) =>
									Effect.logError("[VCS] pull request event handler failed").pipe(
										Effect.annotateLogs({
											handler: name,
											orgId,
											repoFullName: job.repoFullName,
											number: job.number,
											cause: summarizeCause(cause),
										}),
									),
								),
							),
						{ discard: true },
					),
			}
		}),
	)
