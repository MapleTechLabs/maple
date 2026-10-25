import * as Cloudflare from "alchemy/Cloudflare"
import { Cause, Effect, Predicate } from "effect"

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
 * across replays and re-runs a typed failure per `config.retries`; once they
 * are spent the run sees it in the error channel (its data and `_tag` survive,
 * its prototype does not, so match on the tag). A defect, or a failure that
 * cannot be serialized, is terminal and skips the retries.
 * Inside the Effect, read clocks and ids — never in the run body, which replays.
 *
 * A step call the engine drops because the run's Durable Object went away ends the run as an
 * interrupt: Cloudflare replays the instance, so the run must not settle as failed meanwhile.
 */
export const durableStep = <A, E, R>(
	name: string,
	effect: Effect.Effect<A, E, R>,
	config?: DurableStepConfig,
) =>
	Cloudflare.Workflows.task(name, effect, {
		...config,
		timeout: config?.timeout ?? DEFAULT_STEP_TIMEOUT,
	}).pipe(
		Effect.catchCauseIf(
			(cause) => cause.reasons.some((r) => Cause.isDieReason(r) && isInstanceLost(r.defect)),
			() => Effect.interrupt,
		),
	)

/**
 * The run's Durable Object was reset under it (a deploy, an isolate past its memory, a host move).
 * Only the engine's own wording counts, so a step's own failure still fails the run.
 */
const INSTANCE_LOST =
	/this Durable Object instance is no longer active|Durable Object reset because|Network connection lost/

const isInstanceLost = (defect: unknown): boolean =>
	Predicate.hasProperty(defect, "message") &&
	Predicate.isString(defect.message) &&
	INSTANCE_LOST.test(defect.message)
