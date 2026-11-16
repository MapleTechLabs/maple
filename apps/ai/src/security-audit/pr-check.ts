/**
 * The `Maple / security` check: posts a pull request's security run to GitHub as a check run on
 * its head. Running while the audit works, then success, failure (a confirmed finding the pull
 * request brought, at or above the target's threshold) or neutral (it could not finish, which
 * never holds a merge). A branch rule that requires the check is what makes it a merge gate.
 */
import { SECURITY_PR_CHECK_NAME } from "@maple/domain/http"
import type { SecurityAuditTargetRow } from "@maple/db/tables"
import type { OrgId } from "@maple/primitives"
import { Env } from "@maple/backend/platform/Env"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { VcsProviderRegistry } from "@maple/backend/services/integrations/vcs/VcsProviderRegistry"
import { VcsRepository } from "@maple/backend/services/integrations/vcs/VcsRepository"
import { makeRepoUpstream } from "@maple/backend/services/pr-review/repo-upstream"
import { SecurityAuditStore } from "@maple/backend/services/security-audit/SecurityAuditStore"
import { Array as Arr, type Cause, Context, Effect, Layer, Option, String as Str } from "effect"
import { type FindingLifecycle, prCheckVerdict } from "./pr-check-verdict"

/** What the check says before the run has a result. */
export type PrCheckNotice =
	| { readonly kind: "running"; readonly runId: string; readonly scopePaths: number }
	| { readonly kind: "unchecked"; readonly reason: string }

export interface SecurityPrCheckApi {
	/** Writes the check for a pull request's head before or instead of a result. Never fails. */
	readonly notify: (
		orgId: OrgId,
		target: SecurityAuditTargetRow,
		headSha: string,
		notice: PrCheckNotice,
	) => Effect.Effect<void>
	/** Posts a finished pull request run's result; any other run is left alone. Never fails. */
	readonly publish: (orgId: OrgId, runId: string) => Effect.Effect<void>
}

export class SecurityPrCheck extends Context.Service<SecurityPrCheck, SecurityPrCheckApi>()(
	"@maple/ai/security-audit/SecurityPrCheck",
	{
		make: Effect.gen(function* () {
			const stores = yield* SecurityAuditStore
			const repositories = yield* VcsRepository
			const env = yield* Env
			const { upstreamFor } = yield* makeRepoUpstream

			const runUrl = (runId: string) =>
				`${Str.replace(/\/+$/, "")(env.MAPLE_APP_BASE_URL)}/security/code/runs/${encodeURIComponent(runId)}`

			/** The target's connected repository, by its stored link or else by name. */
			const upstreamOfTarget = (orgId: OrgId, target: SecurityAuditTargetRow) =>
				Effect.gen(function* () {
					const connected =
						target.vcsRepositoryId === null
							? yield* stores.forOrg(orgId).findConnectedRepository(target.repository)
							: Option.none()
					const repositoryId =
						target.vcsRepositoryId ?? Option.getOrNull(Option.map(connected, (repo) => repo.id))
					if (repositoryId === null) return Option.none()
					const repo = yield* repositories.getRepositoryById(orgId, repositoryId)
					if (Option.isNone(repo)) return Option.none()
					return yield* upstreamFor(orgId, repo.value)
				})

			const logFailure = (what: string, orgId: OrgId) =>
				Effect.catchCause((cause: Cause.Cause<unknown>) =>
					Effect.logWarning(`[SecurityPrCheck] could not ${what}`).pipe(
						Effect.annotateLogs({ orgId, cause: summarizeCause(cause) }),
					),
				)

			const notify: SecurityPrCheckApi["notify"] = (orgId, target, headSha, notice) =>
				Effect.gen(function* () {
					const upstream = yield* upstreamOfTarget(orgId, target)
					if (Option.isNone(upstream)) return
					const { provider, installation, ref } = upstream.value
					yield* provider.writePullRequestCheck(
						installation,
						ref,
						notice.kind === "running"
							? {
									name: SECURITY_PR_CHECK_NAME,
									headSha,
									state: { status: "in_progress" },
									title: "Auditing the changed files",
									summary: `Maple is auditing ${notice.scopePaths === 1 ? "1 changed path" : `${notice.scopePaths} changed paths`} of this pull request for security issues. Follow it on [the run page](${runUrl(notice.runId)}).`,
									detailsUrl: runUrl(notice.runId),
								}
							: {
									name: SECURITY_PR_CHECK_NAME,
									headSha,
									state: { status: "completed", conclusion: "neutral" },
									title: "Not checked · not blocking",
									summary: `Maple did not audit this pull request: ${notice.reason}. The check does not block the merge.`,
								},
					)
				}).pipe(
					logFailure("write the security check", orgId),
					Effect.withSpan("SecurityPrCheck.notify", {
						attributes: { orgId, "maple.security_pr_check.notice": notice.kind },
					}),
				)

			const publish: SecurityPrCheckApi["publish"] = (orgId, runId) =>
				Effect.gen(function* () {
					const store = stores.forOrg(orgId)
					const run = yield* store.getRun(runId)
					if (Option.isNone(run) || run.value.prNumber === null || run.value.finishedAt === null)
						return
					const target = yield* store.getTarget(run.value.targetId)
					if (Option.isNone(target)) return
					const views = yield* store.listRunFindingViews(runId)
					// A view without a target row of its own carries this run's defaults: not followed.
					const lifecycle = new Map<string, FindingLifecycle>(
						Arr.flatMap(views, (view) =>
							view.firstSeenRunId === run.value.id && view.statusChangedAt === null
								? []
								: [
										[
											view.fingerprint,
											{ status: view.status, statusChangedAt: view.statusChangedAt },
										] as const,
									],
						),
					)
					const verdict = prCheckVerdict({
						findings: Arr.map(views, (view) => view.record),
						lifecycle,
						blockAt: target.value.prCheckBlockAt,
						run: run.value,
						runUrl: runUrl(runId),
					})
					yield* Effect.annotateCurrentSpan({
						"maple.security_pr_check.conclusion": verdict.conclusion,
						"maple.security_pr_check.blocking": Arr.filter(
							verdict.findings,
							(f) => f.standing === "blocking",
						).length,
						"vcs.pull_request.number": run.value.prNumber,
					})
					const upstream = yield* upstreamOfTarget(orgId, target.value)
					if (Option.isNone(upstream)) return
					const { provider, installation, ref } = upstream.value
					yield* provider.writePullRequestCheck(installation, ref, {
						name: SECURITY_PR_CHECK_NAME,
						headSha: run.value.sourceRef,
						state: { status: "completed", conclusion: verdict.conclusion },
						title: verdict.title,
						summary: verdict.summary,
						annotations: verdict.annotations,
						detailsUrl: runUrl(runId),
					})
				}).pipe(
					logFailure("publish the security check", orgId),
					Effect.withSpan("SecurityPrCheck.publish", { attributes: { orgId, runId } }),
				)

			return { notify, publish } satisfies SecurityPrCheckApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(VcsRepository.layer, VcsProviderRegistry.layer)),
	)
}
