/**
 * The run's shared state and the one way the engine calls an agent. The engine is the skill's
 * parent and the only writer: state lives in a `Ref`, every change goes through `mutate` under a
 * single permit, and the store sees each new snapshot before the next decision.
 */
import { Effect, Ref, type Schema, Semaphore } from "effect"
import type { ExecutionProfile } from "../ecosystems"
import type { AgentContext, ExecutionPolicy } from "../prompts"
import type { Candidate, UncoveredSurface } from "../results"
import { decodeAgentJson } from "../results"
import type { CoverageUnit, Finding } from "../schema"
import type { LedgerUnit } from "./ledger"
import { AuditAgents, type AuditRole, AuditStore, type AuditEvent } from "./ports"

export type Profile = "quick" | "standard" | "deep"

export interface PriorRun {
	readonly runId: string
	readonly sourceRef: string
	readonly ledger: ReadonlyArray<CoverageUnit>
	readonly findings: ReadonlyArray<Finding>
}

export interface AuditRunInput {
	readonly runId: string
	readonly repo: string
	/** How agents are told to find the checkout, such as "the repository checkout at /workspace/x". */
	readonly target: string
	readonly sourceRef: string
	readonly profile: Profile
	/** Repository-relative roots; empty audits the whole repository. */
	readonly scopePaths: ReadonlyArray<string>
	/** Maximum agent invocations across all phases, or null for none. */
	readonly budget: number | null
	readonly execution: ExecutionPolicy
	/** The run-level label: which ecosystems and dependencies kept it from executing target code. */
	readonly executionProfile?: ExecutionProfile
	readonly toolGuidance: string
	readonly prior: PriorRun | null
	/** Whether any of these paths changed between the prior run's source and this one. */
	readonly changedSincePrior: (paths: ReadonlyArray<string>) => boolean
	readonly focusedRecon?: ReadonlyArray<{
		readonly subsystem: string
		readonly paths: ReadonlyArray<string>
	}>
	readonly concurrency?: number
	readonly unitsPerHunter?: number
	readonly maxWaves?: number
}

export interface CandidateEntry {
	readonly candidate: Candidate
	readonly agentId: string
}

/** A prior record carried into this run's validation because its source did not change. */
export interface CarriedRecord {
	readonly record: Finding
	readonly coverageId: string
}

export interface EngineState {
	readonly ledger: ReadonlyArray<LedgerUnit>
	readonly architectureMd: string
	readonly spent: number
	readonly candidates: ReadonlyMap<string, ReadonlyArray<CandidateEntry>>
	readonly uncovered: ReadonlyArray<UncoveredSurface>
	readonly carried: ReadonlyArray<CarriedRecord>
	/** Prior rejected claims whose source did not change: they suppress only that exact claim. */
	readonly suppressed: ReadonlyMap<string, Finding>
	readonly findings: ReadonlyMap<string, Finding>
	/** Coverage the run discloses as not done (deferred, partial, unfunded), in the order it arose. */
	readonly gaps: ReadonlyArray<string>
	/** The skill's incomplete-run reasons; any one makes `run_status` incomplete. */
	readonly incomplete: ReadonlyArray<string>
	readonly criticClean: boolean
	/** Every agent id this run spent, so none is ever reused. */
	readonly usedIds: ReadonlySet<string>
	/** Why the host stopped launching agents (the org's budget is spent); null while it launches. */
	readonly halted: string | null
	readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly costUsd: number }
}

export const initialState: EngineState = {
	ledger: [],
	architectureMd: "",
	spent: 0,
	candidates: new Map(),
	uncovered: [],
	carried: [],
	suppressed: new Map(),
	findings: new Map(),
	gaps: [],
	incomplete: [],
	criticClean: false,
	usedIds: new Set(),
	halted: null,
	usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
}

export const makeEngine = (input: AuditRunInput) =>
	Effect.gen(function* () {
		const agents = yield* AuditAgents
		const store = yield* AuditStore
		const state = yield* Ref.make(initialState)
		const permit = yield* Semaphore.make(1)

		const event = (e: AuditEvent) => store.recordEvent(input.runId, e)

		/** Applies `f` under the single parent permit. Persisting is `persist`, at phase boundaries. */
		const mutate = <A>(f: (s: EngineState) => readonly [A, EngineState]) =>
			permit.withPermits(1)(Ref.modify(state, f))

		/** Writes the current ledger: after seeding, after each wave and critic, and at the end. */
		const persist = permit.withPermits(1)(
			Effect.flatMap(Ref.get(state), (s) => store.saveLedger(input.runId, s.ledger)),
		)

		const remaining = Effect.map(Ref.get(state), (s) =>
			s.halted !== null ? 0 : input.budget === null ? Number.POSITIVE_INFINITY : input.budget - s.spent,
		)

		const context = (agentId: string): AgentContext => ({
			agentId,
			toolGuidance: input.toolGuidance,
			execution: input.execution,
		})

		/**
		 * Spends one invocation atomically, or refuses: past a strict budget, or for an id this run
		 * already used (an id is a durable step's name, so a repeat would replay another agent's answer).
		 */
		const reserve = (agentId: string) =>
			Ref.modify(state, (s): readonly ["ok" | "budget" | "duplicate" | "halted", EngineState] =>
				s.usedIds.has(agentId)
					? ["duplicate", s]
					: s.halted !== null
						? ["halted", s]
						: input.budget !== null && s.spent >= input.budget
							? ["budget", s]
							: ["ok", { ...s, spent: s.spent + 1, usedIds: new Set(s.usedIds).add(agentId) }],
			)

		const fail = (reason: string) =>
			Effect.andThen(
				Ref.update(state, (s) =>
					s.incomplete.includes(reason) ? s : { ...s, incomplete: [...s.incomplete, reason] },
				),
				event({ _tag: "Note", message: `incomplete: ${reason}` }),
			)

		/**
		 * The host refused the agent: it never ran, so its invocation is given back (its id stays
		 * used), and nothing launches after it.
		 */
		const halt = (reason: string) =>
			Effect.andThen(
				Ref.update(state, (s) => ({ ...s, spent: s.spent - 1, halted: s.halted ?? reason })),
				fail(reason),
			)

		const refusal = {
			budget: "budget exhausted",
			duplicate: "duplicate agent id",
			halted: "the organization's invocation budget is spent",
		} as const

		/** One fresh agent's final text, or undefined when it was refused or failed (recorded either way). */
		const call = (role: AuditRole, agentId: string, prompt: string) =>
			Effect.gen(function* () {
				const reserved = yield* reserve(agentId)
				if (reserved !== "ok") {
					yield* event({ _tag: "Note", message: `${agentId} not run: ${refusal[reserved]}` })
					return undefined
				}
				const answer = yield* Effect.result(agents.run({ role, agentId, prompt }))
				if (
					answer._tag === "Failure" &&
					answer.failure._tag === "@maple/security-audit/BudgetExhaustedError"
				) {
					yield* event({ _tag: "Note", message: `${agentId} not run: ${answer.failure.message}` })
					yield* halt(answer.failure.reason)
					return undefined
				}
				if (answer._tag === "Failure") {
					yield* event({
						_tag: "Agent",
						role,
						agentId,
						outcome: "failed",
						message: answer.failure.message,
					})
					return undefined
				}
				const usage = answer.success.usage
				if (usage !== undefined) {
					yield* Ref.update(state, (s) => ({
						...s,
						usage: {
							inputTokens: s.usage.inputTokens + usage.inputTokens,
							outputTokens: s.usage.outputTokens + usage.outputTokens,
							costUsd: s.usage.costUsd + (usage.costUsd ?? 0),
						},
					}))
				}
				return answer.success
			})

		/**
		 * One fresh agent whose result is decoded against `schema`. A failed call or a result that breaks
		 * its contract is recorded and answered with `undefined`, never repaired. Store errors propagate.
		 */
		const invoke = <S extends Schema.Top>(role: AuditRole, agentId: string, prompt: string, schema: S) =>
			Effect.gen(function* () {
				const answer = yield* call(role, agentId, prompt)
				if (answer === undefined) return undefined
				const usage = answer.usage
				const decoded = yield* Effect.result(decodeAgentJson(role, schema, answer.text))
				if (decoded._tag === "Failure") {
					yield* event({
						_tag: "Agent",
						role,
						agentId,
						outcome: "discarded",
						message: decoded.failure.message,
						usage,
					})
					return undefined
				}
				yield* event({ _tag: "Agent", role, agentId, outcome: "ok", usage })
				return decoded.success
			})

		/** Free text, for reconnaissance facts. */
		const invokeText = (role: AuditRole, agentId: string, prompt: string) =>
			Effect.gen(function* () {
				const answer = yield* call(role, agentId, prompt)
				if (answer === undefined) return undefined
				if (answer.text.trim() === "") {
					yield* event({
						_tag: "Agent",
						role,
						agentId,
						outcome: "discarded",
						message: "empty answer",
						usage: answer.usage,
					})
					return undefined
				}
				yield* event({ _tag: "Agent", role, agentId, outcome: "ok", usage: answer.usage })
				return answer.text
			})

		const gap = (reason: string) =>
			Effect.andThen(
				Ref.update(state, (s) => (s.gaps.includes(reason) ? s : { ...s, gaps: [...s.gaps, reason] })),
				event({ _tag: "Note", message: reason }),
			)

		return {
			input,
			state,
			store,
			event,
			mutate,
			persist,
			remaining,
			context,
			invoke,
			invokeText,
			gap,
			fail,
		} as const
	})

export type Engine = Effect.Success<ReturnType<typeof makeEngine>>
