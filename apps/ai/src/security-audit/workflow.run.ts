/**
 * One security-audit run inside a Cloudflare Workflow. The engine is the skill's parent; here every
 * agent invocation is a durable step keyed by its agent id, so a deploy or an eviction replays the
 * finished agents from their recorded answers and only re-runs the one in flight. Store writes are
 * full replacements and events are idempotent, which is what makes the replayed parent safe.
 *
 * Clocks are read inside steps or the store only: the body replays.
 */
import { OrgId } from "@maple/domain/http"
import type { SecurityAuditWorkflowPayload } from "@maple/domain/security-audit"
import { durableStep } from "@maple/backend/platform/durable-step"
import { RepoSandboxService } from "@maple/backend/services/sandbox/RepoSandboxService"
import { SecurityAuditStore } from "@maple/backend/services/security-audit/SecurityAuditStore"
import {
	AuditAgents,
	AuditAgentError,
	type AuditAgentsApi,
	AuditStore,
	type AuditStoreApi,
	type PriorRun,
	runAudit,
} from "@maple/security-audit"
import * as Cloudflare from "alchemy/Cloudflare"
import { Cause, type Context, Effect, Layer, Option, Schedule, Schema } from "effect"
import { layerLlm, loadLlmSettings, resolveSecurityAuditModel } from "../platform/Llm"
import { makeAuditAgents } from "./agents"
import { sandboxSource } from "./sandbox-source"
import { AUDIT_TOOL_GUIDANCE, type SourceReaderApi } from "./source"

/** Sandbox reads time out and fail transiently; the parent retries rather than losing a step. */
const STEP_RETRY = { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } } as const

/** An agent may run 20 minutes; its step allows that plus a margin, and retries once. */
const AGENT_STEP = {
	retries: { limit: 1, delay: "30 seconds", backoff: "constant" },
	timeout: "30 minutes",
} as const

const MAX_CHANGED_PATHS = 20_000

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

/**
 * Each invocation a durable step: a replay returns its recorded answer instead of running it again.
 * The run's step context is captured once, so `run` itself has no requirements.
 */
const durableAgents = (
	agents: AuditAgentsApi,
	step: Context.Context<Cloudflare.WorkflowStep>,
): AuditAgentsApi => ({
	run: (invocation) =>
		durableStep(`agent:${invocation.agentId}`, agents.run(invocation), AGENT_STEP).pipe(
			Effect.provide(step),
			// A step's failure keeps its tag but not its class, so it is rebuilt here.
			Effect.mapError(
				(error) =>
					new AuditAgentError({
						message: Schema.is(AuditAgentError)(error) ? error.message : String(error),
						role: invocation.role,
						agentId: invocation.agentId,
					}),
			),
		),
})

/**
 * The Workflow body over an agent factory: the deployed run passes real models, tests pass scripted
 * agents. Everything else (pinning, prior run, durable steps, store) is the same code either way.
 */
export const auditWithAgents = <E, R>(
	payload: SecurityAuditWorkflowPayload,
	agentsFor: (source: SourceReaderApi) => Effect.Effect<AuditAgentsApi, E, R>,
) =>
	Effect.gen(function* () {
		const orgId = Schema.decodeSync(OrgId)(payload.orgId)
		const store = (yield* SecurityAuditStore).forOrg(orgId)
		const sandbox = yield* RepoSandboxService
		const target = { repository: payload.repository, ref: payload.ref }

		const sha = yield* durableStep(
			"resolve-commit",
			sandbox.prepare(orgId, target).pipe(
				Effect.andThen(sandbox.exec(orgId, target, { command: "git", args: ["rev-parse", "HEAD"] })),
				Effect.map((result) => result.stdout.trim()),
			),
			STEP_RETRY,
		)
		const pinned = { repository: payload.repository, ref: sha }

		// Prior records are read, not stepped: a finished run never changes, so a replay reads the same.
		const priorRow = payload.priorRunId === null ? Option.none() : yield* store.getRun(payload.priorRunId)
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
								args: ["diff", "--name-only", prior.sourceRef, "HEAD"],
							})
							.pipe(
								Effect.map((result) =>
									// A cut diff is treated as everything changed: never claim unchanged source we did not see.
									result.truncated
										? ["*"]
										: result.stdout
												.split("\n")
												.filter(Boolean)
												.slice(0, MAX_CHANGED_PATHS),
								),
							),
						STEP_RETRY,
					)
		const changedSet = new Set(changed)

		const agents = yield* agentsFor(sandboxSource(sandbox, orgId, pinned))

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
			changedSincePrior: (paths) => changedSet.has("*") || paths.some((path) => changedSet.has(path)),
		}).pipe(
			// The run composes the engine with its host here.
			// oxlint-disable-next-line effecttsgo/strict-effect-provide
			Effect.provide(
				Layer.mergeAll(
					Layer.succeed(
						AuditAgents,
						durableAgents(agents, yield* Effect.context<Cloudflare.WorkflowStep>()),
					),
					Layer.succeed(AuditStore, retried(store)),
				),
			),
		)
		yield* store.finishRun(
			payload.runId,
			result.status === "complete"
				? { status: "complete" }
				: { status: "incomplete", reason: result.incompleteReasons.join("; ") },
		)
		return { status: result.status, invocations: result.invocations, records: result.findings.length }
	}).pipe(
		// A run that dies (no sandbox on this stage, a step past its retries) still leaves its row
		// settled, never `in_progress` forever. An interrupt is an eviction: the replay finishes it.
		Effect.tapCause((cause) =>
			Cause.hasInterruptsOnly(cause)
				? Effect.void
				: Effect.gen(function* () {
						const store = (yield* SecurityAuditStore).forOrg(
							Schema.decodeSync(OrgId)(payload.orgId),
						)
						yield* store.finishRun(payload.runId, {
							status: "failed",
							error: Cause.pretty(cause).slice(0, 2_000),
						})
					}).pipe(Effect.ignore),
		),
		Effect.withSpan("SecurityAuditWorkflow.run", {
			attributes: { "maple.security_audit.run_id": payload.runId, "maple.org_id": payload.orgId },
		}),
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
