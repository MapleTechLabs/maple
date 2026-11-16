/**
 * A pull request event, from api: whether a target checks this pull request, and if so the run
 * that audits its changed files at the new head. A newer head supersedes the pull request's
 * unfinished run. Anything that stops the audit from starting (no credits, the spend limit, a diff
 * too large to scope) still reports the check, as neutral: the gate fails open.
 */
import type { PullRequestEventJob, SecurityPrCheckOutcome } from "@maple/domain/http"
import { SecurityAuditRunId, securityAuditSpendWindow } from "@maple/domain/security-audit"
import type { SecurityAuditRunRow, SecurityAuditTargetRow } from "@maple/db/tables"
import type { OrgId } from "@maple/primitives"
import { SecurityAuditWorkflowStarter } from "@maple/backend/platform/bindings"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { AiCredits } from "@maple/backend/services/billing/AiCredits"
import { VcsRepository } from "@maple/backend/services/integrations/vcs/VcsRepository"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { makeRepoUpstream } from "@maple/backend/services/pr-review/repo-upstream"
import { securityAuditLimits } from "@maple/backend/services/security-audit/limits"
import { SecurityAuditStore } from "@maple/backend/services/security-audit/SecurityAuditStore"
import { Array as Arr, Clock, Effect, Option, Schema, String as Str } from "effect"
import * as SecureRandom from "effect/crypto/SecureRandom"
import { loadLlmSettings, securityAuditModelIds } from "../platform/Llm"
import { SecurityPrCheck } from "./pr-check"
import { prScope } from "./pr-check-scope"

/**
 * Pushes and openings put new code at the head; an edit can move the pull request onto a branch a
 * target checks. An edit of only the title or body finds the head's run, or its result, and stops.
 */
const CHECKED_ACTIONS: ReadonlySet<PullRequestEventJob["action"]> = new Set([
	"opened",
	"reopened",
	"synchronize",
	"ready_for_review",
	"edited",
])

/** One hunter wave and one verifier per candidate: a pull request's diff, not a whole branch. */
export const PR_CHECK_PROFILE = "quick" as const
/** Agent invocations per pull request run. */
export const PR_CHECK_DEFAULT_BUDGET = 30

const decodeRunId = Schema.decodeSync(SecurityAuditRunId)

const skipped = (reason: string): SecurityPrCheckOutcome => ({ outcome: "skipped", reason })

export const startPullRequestCheck = Effect.fn("SecurityPrCheck.start")(function* (
	orgId: OrgId,
	job: PullRequestEventJob,
) {
	yield* Effect.annotateCurrentSpan({
		orgId,
		"vcs.pull_request.number": job.number,
		"vcs.pull_request.action": job.action,
	})
	if (!CHECKED_ACTIONS.has(job.action)) return skipped("action")
	// The review's debounced copy of a push: the original already started this check.
	if (job.deferredReview === true) return skipped("deferred_copy")
	if (job.draft === true) return skipped("draft")
	const headSha = job.headSha
	const baseRef = job.baseRef
	if (headSha === undefined || baseRef === undefined) return skipped("no_head")

	const store = (yield* SecurityAuditStore).forOrg(orgId)
	const target = yield* store.findPullRequestTarget(job.repoFullName, baseRef)
	if (Option.isNone(target)) return skipped("no_target")

	const checks = yield* SecurityPrCheck
	const report = (reason: string) =>
		checks
			.notify(orgId, target.value, headSha, { kind: "unchecked", reason })
			.pipe(Effect.as<SecurityPrCheckOutcome>({ outcome: "reported", reason }))
	// Flags read as off when Clerk cannot be reached: a target that expects the check still gets one,
	// as not blocking, rather than a check that never comes.
	const flags = yield* (yield* OrganizationFeatureFlagsService).flags(orgId)
	if (!flags.securityAudit) return yield* report("security audits are not enabled for this organization")
	// A branch rule waits forever on a check nobody posts: past this point every failure reports.
	return yield* checkPullRequest(orgId, job, target.value, headSha, report).pipe(
		Effect.catchCause((cause) =>
			Effect.logError("[SecurityPrCheck] the check could not start").pipe(
				Effect.annotateLogs({ orgId, number: job.number, cause: summarizeCause(cause) }),
				Effect.andThen(report("an error stopped the check from starting")),
			),
		),
	)
})

const checkPullRequest = Effect.fn("SecurityPrCheck.checkPullRequest")(function* (
	orgId: OrgId,
	job: PullRequestEventJob,
	target: SecurityAuditTargetRow,
	headSha: string,
	report: (reason: string) => Effect.Effect<SecurityPrCheckOutcome>,
) {
	const store = (yield* SecurityAuditStore).forOrg(orgId)
	const workflow = yield* SecurityAuditWorkflowStarter
	const checks = yield* SecurityPrCheck

	const repo = yield* (yield* VcsRepository).resolveRepository(orgId, job.provider, job.externalRepoId)
	if (Option.isNone(repo)) return skipped("repository_not_connected")
	const upstream = yield* (yield* makeRepoUpstream).upstreamFor(orgId, repo.value)
	if (Option.isNone(upstream)) return skipped("no_installation")
	const { provider, installation, ref } = upstream.value
	// Deliveries can arrive out of order: only the pull request's current head is checked, so an
	// older push never supersedes the run for a newer one.
	const head = yield* provider.fetchPullRequestHead(installation, ref, job.number)
	if (head.headSha !== headSha) return skipped("stale_head")
	// A redelivery after this head's audit finished reuses its result rather than paying again.
	const latest = yield* store.listRuns({ targetId: target.id, prNumber: job.number, limit: 1 })
	const done = latest[0]
	if (done !== undefined && done.sourceRef === headSha && done.status === "complete") {
		yield* checks.publish(orgId, done.id)
		return skipped("already_checked")
	}

	/**
	 * Whether this head already has a run (a redelivery, api's retry): if so it answers. Any other
	 * unfinished run is for an older head, made moot: stopped before it spends more, and its own
	 * check settled, since a terminated Workflow never reports itself.
	 */
	const supersede = Effect.gen(function* () {
		const open = yield* store.listOpenPullRequestRuns(target.id, job.number)
		const same = Arr.findFirst(open, (run) => run.sourceRef === headSha)
		if (Option.isSome(same)) return { _tag: "Answering" as const, run: same.value }
		if (open.length === 0) return { _tag: "Clear" as const }
		// Another head's run started since this delivery read the head: read it again before stopping
		// that run, so a stale delivery never stops the current head's.
		const now = yield* provider.fetchPullRequestHead(installation, ref, job.number)
		if (now.headSha !== headSha) return { _tag: "Stale" as const }
		yield* Effect.forEach(
			open,
			(run) =>
				workflow.cancel(run.id).pipe(
					Effect.catchCause((cause) =>
						Effect.logWarning("[SecurityPrCheck] could not stop a superseded run").pipe(
							Effect.annotateLogs({ orgId, runId: run.id, cause: summarizeCause(cause) }),
						),
					),
					Effect.andThen(
						store.supersedeRun(
							run.id,
							`superseded: a newer push (${Str.slice(0, 7)(headSha)}) is being checked`,
						),
					),
					Effect.andThen(checks.publish(orgId, run.id)),
				),
			{ discard: true },
		)
		return { _tag: "Clear" as const }
	})

	/**
	 * The head's run answers, but its Workflow may never have been created (the delivery that started
	 * it was cut off). One that exists is left alone; a missing one starts now and says so on the
	 * check. A start that fails settles the run as failed, so its check reports and the head is free.
	 * Never re-posts a running check over one that may have finished.
	 */
	const resume = (run: SecurityAuditRunRow) =>
		Effect.gen(function* () {
			if (yield* workflow.exists(run.id)) return
			if (run.discoveryModel === null || run.validationModel === null)
				return yield* settleOrphan(run, "the run has no recorded models")
			// Said before the Workflow exists, so it can never land after the result.
			yield* checks.notify(orgId, target, headSha, {
				kind: "running",
				runId: run.id,
				scopePaths: run.scopePaths.length,
			})
			yield* workflow
				.create({
					orgId,
					runId: run.id,
					repository: target.repository,
					ref: headSha,
					profile: run.profile,
					scopePaths: run.scopePaths,
					budget: run.budget,
					models: { discovery: run.discoveryModel, validation: run.validationModel },
					priorRunId: null,
				})
				.pipe(
					// Another delivery may have created it in between: only a run with no Workflow settles.
					Effect.catchTag("@maple/backend/platform/WorkflowStartError", (error) =>
						workflow
							.exists(run.id)
							.pipe(
								Effect.flatMap((exists) =>
									exists ? Effect.void : settleOrphan(run, error.message),
								),
							),
					),
				)
		})

	const settleOrphan = (run: SecurityAuditRunRow, why: string) =>
		store
			.finishRun(run.id, { status: "failed", error: `start_failed: ${why}` })
			.pipe(Effect.andThen(checks.publish(orgId, run.id)))

	const answering = yield* supersede
	if (answering._tag === "Stale") return skipped("stale_head")
	if (answering._tag === "Answering") {
		yield* resume(answering.run)
		return skipped("already_checking")
	}

	const files = yield* provider.fetchPullRequestFiles(installation, ref, job.number)
	const scope = prScope(files)
	if (scope.kind === "empty") return yield* report("the pull request changes no file to audit")
	// Unscoped audits the whole repository: never a changed file left out.
	const scopePaths = scope.kind === "paths" ? scope.paths : []

	// Paid in AI credits, under the org's monthly audit limit, like any audit.
	const hasCredits = yield* (yield* AiCredits).ensure(orgId).pipe(
		Effect.as(true),
		Effect.catchTags({
			"@maple/backend/billing/AiCreditsExhausted": () => Effect.succeed(false),
			"@maple/backend/billing/AiCreditsUnavailable": () => Effect.succeed(false),
		}),
	)
	if (!hasCredits) return yield* report("the organization has no AI credits left for security audits")
	const storedSettings = yield* store.getSettings
	const settings = Option.getOrNull(storedSettings)
	const limits = yield* securityAuditLimits
	const now = yield* Clock.currentTimeMillis
	const spentUsd = yield* store.orgSpendUsd(securityAuditSpendWindow(now).since)
	if (spentUsd >= (settings?.monthlySpendLimitUsd ?? limits.defaultMonthlySpendLimitUsd))
		return yield* report("the organization reached its monthly security audit spend limit")

	const llmSettings = yield* loadLlmSettings
	const models = securityAuditModelIds(llmSettings, {
		discovery: target.discoveryModel ?? settings?.discoveryModel ?? null,
		validation: target.validationModel ?? settings?.validationModel ?? null,
	})
	const random = yield* SecureRandom.SecureRandom
	const uuid = yield* random.uuidV4()
	const runId = decodeRunId(uuid)
	const start = store
		.startRun({
			runId,
			targetId: target.id,
			kind: "pull_request",
			prNumber: job.number,
			sourceRef: headSha,
			profile: PR_CHECK_PROFILE,
			scopePaths,
			// The target's budget sizes whole-branch runs; a diff gets the pull request's own.
			budget: PR_CHECK_DEFAULT_BUDGET,
			discoveryModel: models.discovery,
			validationModel: models.validation,
			workflowInstanceId: runId,
		})
		.pipe(Effect.asSome)
	const outcome = yield* start.pipe(
		Effect.map((run) => ({ _tag: "Started" as const, run })),
		Effect.catchTags({
			// Another delivery started a run in between. A push since this one was read makes this
			// delivery the stale one: it stands down. Otherwise the same head answers itself, an older
			// one is superseded and this start tried once more.
			"@maple/backend/security-audit/RunInProgress": () =>
				Effect.gen(function* () {
					const now = yield* provider.fetchPullRequestHead(installation, ref, job.number)
					if (now.headSha !== headSha) return { _tag: "Stale" as const }
					const raced = yield* supersede
					if (raced._tag === "Stale") return { _tag: "Stale" as const }
					if (raced._tag === "Answering") return { _tag: "Checking" as const }
					const retriedRun = yield* start.pipe(
						Effect.catchTag(
							"@maple/backend/security-audit/RunInProgress",
							() => Effect.succeedNone,
						),
					)
					return { _tag: "Started" as const, run: retriedRun }
				}),
			"@maple/backend/security-audit/TargetDisabled": () =>
				Effect.succeed({ _tag: "Disabled" as const }),
		}),
	)
	if (outcome._tag === "Checking") return skipped("already_checking")
	if (outcome._tag === "Stale") return skipped("stale_head")
	if (outcome._tag === "Disabled") return skipped("target_disabled")
	const run = outcome.run
	if (Option.isNone(run)) return yield* report("another check of this pull request is starting")

	yield* checks.notify(orgId, target, headSha, {
		kind: "running",
		runId: run.value.id,
		scopePaths: scopePaths.length,
	})
	const started = yield* workflow
		.create({
			orgId,
			runId: run.value.id,
			repository: target.repository,
			ref: headSha,
			profile: run.value.profile,
			scopePaths: run.value.scopePaths,
			budget: run.value.budget,
			models,
			// A pull request's head is not the branch; nothing carries forward.
			priorRunId: null,
		})
		.pipe(
			Effect.as(true),
			Effect.catch((error) =>
				store
					.finishRun(run.value.id, { status: "failed", error: `start_failed: ${error.message}` })
					.pipe(Effect.as(false)),
			),
		)
	if (!started) return yield* report("the audit could not start")
	return { outcome: "started" } satisfies SecurityPrCheckOutcome
})
