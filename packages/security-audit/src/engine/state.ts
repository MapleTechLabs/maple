/**
 * The run's shared state and the one way the engine calls an agent. The engine is the skill's
 * parent and the only writer: state lives in a `Ref`, every change goes through `mutate` under a
 * single permit, and the store sees each new snapshot before the next decision.
 */
import { Effect, Ref, type Schema, Semaphore } from "effect"
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
}

export const makeEngine = (input: AuditRunInput) =>
	Effect.gen(function* () {
		const agents = yield* AuditAgents
		const store = yield* AuditStore
		const state = yield* Ref.make(initialState)
		const permit = yield* Semaphore.make(1)

		const event = (e: AuditEvent) => store.recordEvent(input.runId, e)

		/** Applies `f` under the single parent permit and persists the ledger it produced. */
		const mutate = <A>(f: (s: EngineState) => readonly [A, EngineState]) =>
			permit.withPermits(1)(
				Effect.gen(function* () {
					const [result, next] = yield* Ref.modify(state, (s) => {
						const [a, n] = f(s)
						return [[a, n] as const, n]
					})
					yield* store.saveLedger(input.runId, next.ledger)
					return result
				}),
			)

		const remaining = Effect.map(Ref.get(state), (s) =>
			input.budget === null ? Number.POSITIVE_INFINITY : input.budget - s.spent,
		)

		const context = (agentId: string): AgentContext => ({
			agentId,
			toolGuidance: input.toolGuidance,
			execution: input.execution,
		})

		/**
		 * One fresh agent. Its result is decoded against `schema`; a failed call or a result that breaks
		 * its contract is recorded and answered with `undefined`, never repaired.
		 */
		const invoke = <S extends Schema.Top>(role: AuditRole, agentId: string, prompt: string, schema: S) =>
			Effect.gen(function* () {
				yield* Ref.update(state, (s) => ({ ...s, spent: s.spent + 1 }))
				const answer = yield* agents.run({ role, agentId, prompt }).pipe(
					Effect.tapError((error) =>
						event({ _tag: "Agent", role, agentId, outcome: "failed", message: error.message }),
					),
					Effect.option,
				)
				if (answer._tag === "None") return undefined
				const usage = answer.value.usage
				const decoded = yield* decodeAgentJson(role, schema, answer.value.text).pipe(
					Effect.tapError((error) =>
						event({
							_tag: "Agent",
							role,
							agentId,
							outcome: "discarded",
							message: error.message,
							usage,
						}),
					),
					Effect.option,
				)
				if (decoded._tag === "None") return undefined
				yield* event({
					_tag: "Agent",
					role,
					agentId,
					outcome: "ok",
					usage,
				})
				return decoded.value
			})

		/** Free text, for reconnaissance facts. */
		const invokeText = (role: AuditRole, agentId: string, prompt: string) =>
			Effect.gen(function* () {
				yield* Ref.update(state, (s) => ({ ...s, spent: s.spent + 1 }))
				const answer = yield* agents.run({ role, agentId, prompt }).pipe(
					Effect.tapError((error) =>
						event({ _tag: "Agent", role, agentId, outcome: "failed", message: error.message }),
					),
					Effect.option,
				)
				if (answer._tag === "None" || answer.value.text.trim() === "") return undefined
				const usage = answer.value.usage
				yield* event({
					_tag: "Agent",
					role,
					agentId,
					outcome: "ok",
					usage,
				})
				return answer.value.text
			})

		const gap = (reason: string) =>
			Effect.andThen(
				Ref.update(state, (s) => (s.gaps.includes(reason) ? s : { ...s, gaps: [...s.gaps, reason] })),
				event({ _tag: "Note", message: reason }),
			)

		const fail = (reason: string) =>
			Effect.andThen(
				Ref.update(state, (s) =>
					s.incomplete.includes(reason) ? s : { ...s, incomplete: [...s.incomplete, reason] },
				),
				event({ _tag: "Note", message: `incomplete: ${reason}` }),
			)

		return {
			input,
			state,
			store,
			event,
			mutate,
			remaining,
			context,
			invoke,
			invokeText,
			gap,
			fail,
		} as const
	})

export type Engine = Effect.Success<ReturnType<typeof makeEngine>>
