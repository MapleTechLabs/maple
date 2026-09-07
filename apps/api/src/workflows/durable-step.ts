import * as Cloudflare from "alchemy/Cloudflare"
import { Effect } from "effect"

/** Retries and timeout for one step, as Cloudflare's step API takes them. */
export type DurableStepConfig = Cloudflare.WorkflowStepConfig

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
) => Cloudflare.Workflows.task(name, Effect.orDie(effect), config)
