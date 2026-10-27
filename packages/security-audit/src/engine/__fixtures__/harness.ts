/**
 * Scripted agents and an in-memory store for engine tests. Each scenario answers by role and by the
 * coverage ids a hunter prompt carries, the way a real agent sees only its own prompt.
 */
import { Effect, Layer } from "effect"
import type { HunterResult, SeedUnit } from "../../results"
import type { CoverageUnit, Finding } from "../../schema"
import { coverageId } from "../../validators"
import {
	type AgentAnswer,
	type AgentInvocation,
	AuditAgentError,
	AuditAgents,
	type AuditEvent,
	type AuditReports,
	AuditStore,
} from "../ports"
import { runAudit } from "../run"
import type { AuditRunInput } from "../state"

export const seed = (name: string, attackClass: string, overrides: Partial<SeedUnit> = {}): SeedUnit => ({
	canonical_refs: {
		surface: `src/routes/${name}.ts#POST /${name}`,
		boundary: `src/services/${name}.ts#authorize`,
		subsystem: "src/services",
		attack_class: `ATTACK-CLASSES.md#${attackClass}`,
	},
	surface: `POST /${name}`,
	boundary: `${name} authorization`,
	subsystem: "services",
	attack_class: attackClass,
	starting_paths: [`src/routes/${name}.ts`],
	ordinary_attack_class_block: `ATTACK-CLASSES.md#${attackClass}`,
	selected_companion_blocks: [],
	excluded_blocks: [],
	...overrides,
})

export const idOf = (unit: SeedUnit) => coverageId(unit.canonical_refs)

export const KEYS = seed("keys", "Access control", { priority: 1 })
export const SEARCH = seed("search", "Injection", { priority: 2 })
export const EXPORT = seed("export", "Feature abuse and data leakage")
export const FINGERPRINT = "keys/roll-missing-org-scope"

const trace = [
	{
		kind: "entrypoint",
		file: "src/routes/keys.ts",
		line: 12,
		scope: "POST /keys",
		description: "takes a key id",
	},
	{
		kind: "sink",
		file: "src/services/keys.ts",
		line: 40,
		scope: "rollKey",
		description: "rolls without org check",
	},
] as const

export const confirmed = (overrides: Partial<Extract<Finding, { verdict: "confirmed" }>> = {}): Finding => ({
	verdict: "confirmed",
	fingerprint: FINGERPRINT,
	title: "Any org member can roll another org's API key",
	description: "rollKey looks the key up by id alone.",
	root_cause: "rollKey omits the org_id predicate.",
	intended_behavior: "A key is only rolled within the caller's org.",
	trace: [...trace],
	evidence: [{ file: "src/services/keys.ts", line: 40, description: "lookup by id only" }],
	conditions: [{ kind: "authentication_level", description: "any org member" }],
	execution: {
		attacker_perspective: "member of org A",
		payloads: ["POST /keys/<org B key>/roll"],
		instructions: ["call the route as org A with an org B key id"],
		observed_result: "the source trace reaches rollKey with no org predicate",
	},
	remediation: { strategy: "filter by the caller's org_id in rollKey" },
	severity: {
		likelihood: { score: "medium", reason: "needs a key id" },
		impact: { score: "high", reason: "cross-tenant write" },
		overall_severity: "high",
	},
	confidence: { score: "medium", reason: "source trace complete" },
	...overrides,
})

/** The same claim with a lower demonstrated impact: a material change. */
export const lowered = (): Finding =>
	confirmed({
		severity: {
			likelihood: { score: "medium", reason: "needs a key id" },
			impact: { score: "medium", reason: "limited to key rotation" },
			overall_severity: "medium",
		},
	})

export const rejectedRecord: Finding = {
	verdict: "rejected",
	fingerprint: FINGERPRINT,
	title: "Any org member can roll another org's API key",
	description: "rollKey looks the key up by id alone.",
	claimed_root_cause: "rollKey omits the org_id predicate.",
	trace: [...trace],
	evidence: [{ file: "src/services/keys.ts", line: 40, description: "lookup by id only" }],
	reason: "the route's middleware scopes the key to the caller's org",
}

const { verdict: _verdict, ...candidateFields } = confirmed() as Extract<Finding, { verdict: "confirmed" }>
export const keysCandidate = { proposed_verdict: "confirmed" as const, ...candidateFields }

/** A hunter's answer covering every unit it owns, with a candidate on the keys unit. */
export const hunterAnswer = (invocation: AgentInvocation, ids: ReadonlyArray<string>): HunterResult => {
	const owned = ids.filter((id) => invocation.prompt.includes(`"coverage_id": "${id}"`))
	const keys = idOf(KEYS)
	return {
		units: owned.map((id) => ({
			coverage_id: id,
			disposition: id === keys ? "candidate" : "covered",
			reviewed_paths: ["src/services/keys.ts"],
			checks: [
				{
					agent_id: invocation.agentId,
					reviewed_paths: ["src/services/keys.ts"],
					invariant: "org scope on the route",
					method: "source",
					result: id === keys ? "no org predicate" : "scoped",
					artifact: null,
				},
			],
			candidate_fingerprints: id === keys ? [FINGERPRINT] : [],
			unresolved: [],
		})),
		candidates: owned.includes(keys) ? [keysCandidate] : [],
		hardening: [],
		uncovered: [],
	}
}

export const emptyCritic = { missing_units: [], reassign_ids: [], resolved_prior_leads: [], stop: true }

export const json = (value: unknown) => JSON.stringify(value)

export interface Recorded {
	readonly invocations: Array<AgentInvocation>
	readonly events: Array<AuditEvent>
	ledger: ReadonlyArray<CoverageUnit>
	findings: ReadonlyArray<Finding>
	reports: AuditReports | undefined
}

export const baseInput = (overrides: Partial<AuditRunInput> = {}): AuditRunInput => ({
	runId: "run-1",
	repo: "acme/api",
	target: "the repository checkout at /work/acme",
	sourceRef: "abc123",
	profile: "deep",
	scopePaths: [],
	budget: null,
	execution: { _tag: "Unavailable", blocker: "no OS-enforced sandbox in tests" },
	toolGuidance: "Read files with read_file.",
	prior: null,
	changedSincePrior: () => false,
	concurrency: 1,
	...overrides,
})

/** An agent that failed outright (a transport error, a dead step), not one that answered badly. */
export const agentFailure = (invocation: AgentInvocation) =>
	new AuditAgentError({
		message: "upstream closed the stream",
		role: invocation.role,
		agentId: invocation.agentId,
	})

/**
 * Runs the engine against a scripted answer function and records what it did. A string is the
 * answer's text; an `AgentAnswer` adds its tool-call count; an `AuditAgentError` fails the agent.
 */
export const runScripted = (
	input: AuditRunInput,
	answer: (invocation: AgentInvocation) => string | AgentAnswer | AuditAgentError,
) => {
	const recorded: Recorded = { invocations: [], events: [], ledger: [], findings: [], reports: undefined }
	const agents = Layer.succeed(AuditAgents, {
		run: (invocation) =>
			Effect.suspend((): Effect.Effect<AgentAnswer, AuditAgentError> => {
				recorded.invocations.push(invocation)
				const scripted = answer(invocation)
				return typeof scripted === "string"
					? Effect.succeed({ text: scripted })
					: scripted instanceof AuditAgentError
						? Effect.fail(scripted)
						: Effect.succeed(scripted)
			}),
	})
	const store = Layer.succeed(AuditStore, {
		saveMetadata: () => Effect.void,
		saveArchitecture: () => Effect.void,
		saveLedger: (_, ledger) => Effect.sync(() => void (recorded.ledger = ledger)),
		saveFindings: (_, findings) => Effect.sync(() => void (recorded.findings = findings)),
		saveReports: (_, reports) => Effect.sync(() => void (recorded.reports = reports)),
		recordEvent: (_, event) => Effect.sync(() => void recorded.events.push(event)),
	})
	// The test is the entry point that composes the engine with its host.
	// oxlint-disable-next-line effecttsgo/strict-effect-provide
	return Effect.runPromise(runAudit(input).pipe(Effect.provide(Layer.mergeAll(agents, store)))).then(
		(result) => ({
			result,
			recorded,
		}),
	)
}
