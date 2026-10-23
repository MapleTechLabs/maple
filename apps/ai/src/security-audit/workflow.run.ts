/**
 * One security-audit run inside a Cloudflare Workflow. The engine is the skill's parent; here every
 * agent invocation is a durable step keyed by its agent id, so a deploy or an eviction replays the
 * finished agents from their recorded answers and only re-runs the one in flight. Store writes are
 * full replacements and events are idempotent, which is what makes the replayed parent safe.
 *
 * Clocks are read inside steps or the store only: the body replays.
 */
import { OrgId } from "@maple/domain/http"
import { ORG_BUDGET_EXHAUSTED, type SecurityAuditWorkflowPayload } from "@maple/domain/security-audit"
import { durableStep } from "@maple/backend/platform/durable-step"
import { trackSecurityAuditInvocations } from "@maple/backend/services/billing/autumn-tracker"
import { RepoSandboxService } from "@maple/backend/services/sandbox/RepoSandboxService"
import { securityAuditLimits } from "@maple/backend/services/security-audit/limits"
import { SecurityAuditStore } from "@maple/backend/services/security-audit/SecurityAuditStore"
import {
	type AgentAnswer,
	type AgentInvocation,
	AuditAgents,
	AuditAgentError,
	type AuditAgentsApi,
	AuditBudgetExhaustedError,
	AuditStore,
	type AuditStoreApi,
	type AuditStoreError,
	changedMatcher,
	EVERYTHING_CHANGED,
	type PriorRun,
	runAudit,
} from "@maple/security-audit"
import * as Cloudflare from "alchemy/Cloudflare"
import { Cause, type Context, Effect, Layer, Option, Predicate, Schedule, Schema } from "effect"
import { HttpClient } from "effect/http"
import { layerLlm, loadLlmSettings, resolveSecurityAuditModel } from "../platform/Llm"
import { makeAuditAgents } from "./agents"
import {
	AuditRepositoryRefusedError,
	parseRepoSize,
	REPO_SIZE_COMMAND,
	refusalReason,
	repoLimitViolations,
} from "./repo-size"
import { sandboxSource } from "./sandbox-source"
import { AUDIT_TOOL_GUIDANCE, type SourceReaderApi } from "./source"

export class AuditCommitUnresolvedError extends Schema.TaggedError<AuditCommitUnresolvedError>()(
	"@maple/ai/security-audit/CommitUnresolvedError",
	{ message: Schema.String },
) {}

/** Sandbox reads time out and fail transiently; the parent retries rather than losing a step. */
const STEP_RETRY = { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } } as const

/** An agent may run 20 minutes; its step allows that plus a margin, and retries once. */
const AGENT_STEP = {
	retries: { limit: 1, delay: "30 seconds", backoff: "constant" },
	timeout: "30 minutes",
} as const

const MAX_CHANGED_PATHS = 20_000

/** Counting a very large tree takes a while; the sandbox's own ceiling is 120 seconds. */
const REPO_SIZE_TIMEOUT_SECONDS = 120

/** Store writes retried on transient database errors; every write is a replacement or idempotent. */
const retried = (store: AuditStoreApi): AuditStoreApi => {
	const policy = Schedule.max([Schedule.exponential("500 millis", 2.0), Schedule.recurs(3)])
	return {
		saveMetadata: (m) => Effect.retry(store.saveMetadata(m), policy),
		saveArchitecture: (r, md) => Effect.retry(store.saveArchitecture(r, md), policy),
		saveLedger: (r, l) => Effect.retry(store.saveLedger(r, l), policy),
		saveFindings: (r, f) => Effect.retry(store.saveFindings(r, f), policy),
		saveReports: (r, x) => Effect.retry(store.saveReports(r, x), policy),
		recordEvent: (r, e) => Effect.retry(store.recordEvent(r, e), policy),
	}
}

const messageOf = (error: unknown): string =>
	Predicate.hasProperty(error, "message") && Predicate.isString(error.message)
		? error.message
		: String(error)

/**
 * Each invocation a durable step: a replay returns its recorded answer instead of running it again.
 * Before it, `admit` reserves the invocation from the org's monthly budget in its own durable step,
 * so a replay neither reserves nor bills it twice. The run's step context is captured once.
 */
const durableAgents = (
	agents: AuditAgentsApi,
	step: Context.Context<Cloudflare.WorkflowStep>,
	admit: (agentId: string) => Effect.Effect<boolean, AuditStoreError>,
): AuditAgentsApi => ({
	run: (invocation) => {
		const refused = (message: string, reason: string) =>
			new AuditBudgetExhaustedError({ message, agentId: invocation.agentId, reason })
		const admitted: Effect.Effect<boolean, AuditBudgetExhaustedError> = durableStep(
			`org-budget:${invocation.agentId}`,
			admit(invocation.agentId),
			STEP_RETRY,
		).pipe(
			Effect.provide(step),
			// A budget that cannot be read is not a budget with room: the run stops rather than overspend.
			Effect.mapError((error) =>
				refused(
					`the organization's invocation budget could not be read: ${messageOf(error)}`,
					"org_budget_unavailable",
				),
			),
		)
		return Effect.flatMap(
			admitted,
			(granted): Effect.Effect<AgentAnswer, AuditAgentError | AuditBudgetExhaustedError> =>
				granted
					? runAgentStep(agents, step, invocation)
					: Effect.fail(
							refused(
								"the organization's monthly invocation budget is spent",
								ORG_BUDGET_EXHAUSTED,
							),
						),
		)
	},
})

const runAgentStep = (
	agents: AuditAgentsApi,
	step: Context.Context<Cloudflare.WorkflowStep>,
	invocation: AgentInvocation,
) =>
	durableStep(`agent:${invocation.agentId}`, agents.run(invocation), AGENT_STEP).pipe(
		Effect.provide(step),
		// A replayed failure keeps its fields but not its class, so it is rebuilt from them.
		Effect.mapError(
			(error) =>
				new AuditAgentError({
					message: messageOf(error),
					role: invocation.role,
					agentId: invocation.agentId,
				}),
		),
		// A step that dies (its timeout, an isolate past its CPU limit) costs that agent, not the run.
		Effect.catchDefect((defect) =>
			Effect.fail(
				new AuditAgentError({
					message: `agent step died: ${Cause.pretty(Cause.die(defect)).slice(0, 600)}`,
					role: invocation.role,
					agentId: invocation.agentId,
				}),
			),
		),
	)

/**
 * The Workflow body over an agent factory: the deployed run passes real models, tests pass scripted
 * agents. Everything else (pinning, prior run, durable steps, store) is the same code either way.
 */
export const auditWithAgents = <E, R>(
	payload: SecurityAuditWorkflowPayload,
	agentsFor: (source: SourceReaderApi) => Effect.Effect<AuditAgentsApi, E, R>,
) =>
	Effect.gen(function* () {
		const orgId = yield* Schema.decodeUnknownEffect(OrgId)(payload.orgId)
		yield* Effect.annotateCurrentSpan({
			"maple.security_audit.run_id": payload.runId,
			"maple.org_id": orgId,
		})
		const store = (yield* SecurityAuditStore).forOrg(orgId)
		// A run its starter already gave up on (a failed start that still created the instance) stays out.
		const self = yield* store.getRun(payload.runId)
		// Settled already (by its own settle step, or failed by its starter): a replay must not redo it.
		if (Option.isSome(self) && self.value.finishedAt !== null) {
			return {
				status: self.value.status === "complete" ? ("complete" as const) : ("incomplete" as const),
				invocations: self.value.invocationsSpent,
				records: 0,
			}
		}
		const sandbox = yield* RepoSandboxService
		const target = { repository: payload.repository, ref: payload.ref }

		const sha = yield* durableStep(
			"resolve-commit",
			sandbox.prepare(orgId, target).pipe(
				Effect.andThen(sandbox.exec(orgId, target, { command: "git", args: ["rev-parse", "HEAD"] })),
				Effect.flatMap((result) =>
					result.exitCode === 0 && /^[0-9a-f]{40}$/.test(result.stdout.trim())
						? Effect.succeed(result.stdout.trim())
						: Effect.fail(
								new AuditCommitUnresolvedError({
									message: `cannot pin ${payload.ref}: ${result.stderr.trim().slice(0, 300)}`,
								}),
							),
				),
			),
			STEP_RETRY,
		)
		const pinned = { repository: payload.repository, ref: sha }

		// Measured before any agent: a repository over a limit is refused whole, never partly audited.
		const measured = yield* durableStep(
			"repo-size",
			sandbox
				.exec(orgId, pinned, { ...REPO_SIZE_COMMAND, timeoutSeconds: REPO_SIZE_TIMEOUT_SECONDS })
				.pipe(
					Effect.map((result) =>
						Option.match(
							result.exitCode === 0 && !result.truncated
								? parseRepoSize(result.stdout)
								: Option.none(),
							{
								onNone: () => ({
									unreadable: `exit ${result.exitCode}: ${result.stderr.trim().slice(0, 300)}`,
								}),
								onSome: (size) => ({ size }),
							},
						),
					),
				),
			STEP_RETRY,
		)
		const violations =
			"size" in measured
				? repoLimitViolations(measured.size, yield* securityAuditLimits)
				: [`its size could not be measured (${measured.unreadable})`]
		if (violations.length > 0) {
			const reason = refusalReason(violations)
			yield* store.recordEvent(payload.runId, { _tag: "Note", message: reason })
			yield* store.finishRun(payload.runId, { status: "failed", error: reason })
			return yield* new AuditRepositoryRefusedError({ message: reason, violations })
		}

		// Prior records are read, not stepped: a finished run never changes, so a replay reads the same.
		// Only a finished run of the same repository counts; anything else would make replays disagree.
		const priorRow = Option.filter(
			payload.priorRunId === null ? Option.none() : yield* store.getRun(payload.priorRunId),
			(row) =>
				(row.status === "complete" || row.status === "incomplete") &&
				row.metadata !== null &&
				row.metadata.repo === payload.repository,
		)
		const prior: PriorRun | null = Option.isNone(priorRow)
			? null
			: {
					runId: priorRow.value.id,
					sourceRef: priorRow.value.sourceRef,
					ledger: (yield* store.listUnits(priorRow.value.id)).map((row) => row.unit),
					findings: yield* store.listRunFindings(priorRow.value.id),
				}
		const changed =
			prior === null
				? []
				: yield* durableStep(
						"changed-since-prior",
						sandbox
							.exec(orgId, pinned, {
								command: "git",
								// A rename lists only its new path without --no-renames; the old path changed too.
								args: ["diff", "--name-only", "--no-renames", prior.sourceRef, "HEAD"],
							})
							.pipe(
								Effect.map((result) =>
									// A cut or failed diff (an unreachable prior commit) counts as everything changed.
									result.truncated || result.exitCode !== 0
										? [EVERYTHING_CHANGED]
										: result.stdout
												.split("\n")
												.filter(Boolean)
												.slice(0, MAX_CHANGED_PATHS),
								),
							),
						STEP_RETRY,
					)
		const changedSincePrior = changedMatcher(changed)

		const agents = yield* agentsFor(sandboxSource(sandbox, orgId, pinned))
		const httpClient = yield* HttpClient.HttpClient
		/** One invocation from the org's month, billed once it is granted. */
		const admit = (agentId: string) =>
			store.reserveOrgInvocation(payload.orgBudget.period, payload.orgBudget.limit).pipe(
				Effect.tap((granted) =>
					granted
						? trackSecurityAuditInvocations({
								orgId,
								runId: payload.runId,
								agentId,
								invocations: 1,
							}).pipe(Effect.provideService(HttpClient.HttpClient, httpClient))
						: Effect.void,
				),
			)

		const result = yield* runAudit({
			runId: payload.runId,
			repo: payload.repository,
			target: `the repository ${payload.repository} at commit ${sha}, read through your tools${payload.scopePaths.length === 0 ? "" : `; this run is scoped to ${payload.scopePaths.join(", ")}, so map those paths and only what they depend on or are reached from`}`,
			sourceRef: sha,
			profile: payload.profile,
			scopePaths: payload.scopePaths,
			budget: payload.budget,
			execution: {
				_tag: "Unavailable",
				blocker:
					"the repository sandbox does not yet provide per-agent scratch space, resource limits and artifact promotion",
			},
			toolGuidance: AUDIT_TOOL_GUIDANCE,
			prior,
			changedSincePrior,
		}).pipe(
			// The run composes the engine with its host here.
			// oxlint-disable-next-line effecttsgo/strict-effect-provide
			Effect.provide(
				Layer.mergeAll(
					Layer.succeed(
						AuditAgents,
						durableAgents(agents, yield* Effect.context<Cloudflare.WorkflowStep>(), admit),
					),
					Layer.succeed(AuditStore, retried(store)),
				),
			),
		)
		// One durable, retried step: a replay neither double-counts usage nor re-settles the run.
		const settle = Effect.gen(function* () {
			yield* store.setUsage(payload.runId, {
				invocations: result.invocations,
				inputTokens: result.usage.inputTokens,
				outputTokens: result.usage.outputTokens,
				costUsd: result.usage.costUsd,
			})
			// Only a full pass can say a finding is gone: no disclosed gaps, not quick, not scoped, and
			// the finding is not tied to a unit this run left unaudited (deferred, blocked, out of scope).
			const row = yield* store.getRun(payload.runId)
			const unaudited = new Set(
				result.ledger
					.filter(
						(u) =>
							u.status !== "covered" &&
							u.status !== "candidate" &&
							u.status !== "not_applicable",
					)
					.flatMap((u) => [
						...u.result_fingerprints,
						...(u.carried_fingerprint === undefined ? [] : [u.carried_fingerprint]),
					]),
			)
			if (
				result.status === "complete" &&
				result.gaps.length === 0 &&
				payload.profile !== "quick" &&
				payload.scopePaths.length === 0 &&
				prior !== null &&
				// An unread or cut diff is evidence of nothing; claiming a fix needs the diff.
				!changed.includes(EVERYTHING_CHANGED) &&
				Option.isSome(row) &&
				// Cancelled (or otherwise finished) meanwhile: never mark fixed, and finishRun keeps its outcome.
				row.value.finishedAt === null
			) {
				const reported = new Set(result.findings.map((f) => f.fingerprint))
				const gone = (yield* store.listFindings(row.value.targetId)).filter(
					(f) =>
						f.status === "open" &&
						f.verdict !== "rejected" &&
						!reported.has(f.fingerprint) &&
						!unaudited.has(f.fingerprint) &&
						changedSincePrior([
							...f.record.trace.map((t) => t.file),
							...f.record.evidence.map((e) => e.file),
						]),
				)
				if (gone.length > 0)
					yield* store.markFixed(
						row.value.targetId,
						gone.map((f) => f.fingerprint),
						payload.runId,
					)
			}
			yield* store.finishRun(
				payload.runId,
				result.status === "complete"
					? { status: "complete" }
					: { status: "incomplete", reason: result.incompleteReasons.join("; ") },
			)
		})
		yield* durableStep("settle", settle, STEP_RETRY)
		return { status: result.status, invocations: result.invocations, records: result.findings.length }
	}).pipe(
		// A run that dies (no sandbox on this stage, a step past its retries) still leaves its row
		// settled, never `in_progress` forever. An interrupt is an eviction: the replay finishes it.
		Effect.tapCause((cause) =>
			Cause.hasInterruptsOnly(cause)
				? Effect.void
				: Effect.gen(function* () {
						const orgId = yield* Schema.decodeUnknownEffect(OrgId)(payload.orgId)
						const store = (yield* SecurityAuditStore).forOrg(orgId)
						yield* store.finishRun(payload.runId, {
							status: "failed",
							error: Cause.pretty(cause).slice(0, 2_000),
						})
					}).pipe(Effect.ignore),
		),
	)

/** The deployed run: discovery and validation on their own models, priced by OpenRouter. */
export const runSecurityAuditWorkflow = (payload: SecurityAuditWorkflowPayload) =>
	auditWithAgents(payload, (source) =>
		Effect.gen(function* () {
			const settings = yield* loadLlmSettings
			const tags = {
				surface: "chat" as const,
				orgId: payload.orgId,
				sessionId: `audit-${payload.runId}`,
			}
			const models = {
				discovery: resolveSecurityAuditModel(settings, "discovery", tags),
				validation: resolveSecurityAuditModel(settings, "validation", tags),
			}
			return yield* makeAuditAgents(models, source).pipe(
				// The Workflow run is the entry point that owns these clients.
				// oxlint-disable-next-line effecttsgo/strict-effect-provide
				Effect.provide(layerLlm(settings)),
			)
		}),
	)
