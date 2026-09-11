import * as Cloudflare from "alchemy/Cloudflare"
import { Effect } from "effect"

/** Retries and timeout for one step, as Cloudflare's step API takes them. */
export type DurableStepConfig = Cloudflare.WorkflowStepConfig

/**
 * Cloudflare's own per-step default, restated here because a config that sets
 * only `retries` reaches the engine as `{ retries, timeout: undefined }`, and
 * the engine spreads that over its defaults — so the explicit `undefined` wins
 * and its duration parse throws `Cannot read properties of undefined (reading
 * 'match')` before the step can report. That killed every retries-only step,
 * `claim` first, which is the whole fan-out (2026-09-10).
 */
const DEFAULT_STEP_TIMEOUT = "10 minutes"

/**
 * One durable step of a Workflow run: `Cloudflare.Workflows.task` over an
 * Effect whose failure REJECTS the step. Cloudflare persists a step's value
 * across replays and re-runs a rejected step per `config.retries`; a run sees
 * the step fail only once the retries are spent, as a defect. Failures a run
 * wants to handle belong inside the step's own Effect, before this boundary.
 * Inside the Effect, read clocks and ids — never in the run body, which replays.
 */
export const durableStep = <A, E, R>(
	name: string,
	effect: Effect.Effect<A, E, R>,
	config?: DurableStepConfig,
) =>
	Cloudflare.Workflows.task(name, Effect.orDie(effect), {
		...config,
		timeout: config?.timeout ?? DEFAULT_STEP_TIMEOUT,
	})
