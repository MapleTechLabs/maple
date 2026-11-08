import { RuntimeContext } from "alchemy/RuntimeContext"
import { Effect } from "effect"

/** Discharge alchemy's phantom color, the way alchemy's own runtime helpers do. */
export const dischargeRuntimeContext = <A, E>(
	effect: Effect.Effect<A, E, RuntimeContext>,
): Effect.Effect<A, E> =>
	// oxlint-disable-next-line effecttsgo/strict-effect-provide -- a phantom tag with no service behind it; nothing to compose at a root
	Effect.provide(effect, RuntimeContext.phantom)
