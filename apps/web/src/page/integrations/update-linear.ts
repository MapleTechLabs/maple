import type { LinearIntegrationStatus } from "@maple/domain/http"
import { successOf } from "../infra-integrations/kit/success-of"
import { completedSwitches, settledSwitches, toggledSwitches } from "./feature-switches"
import {
	type LinearCardModel,
	type LinearFeatureFlag,
	LinearMessage,
	SaveLinearFeatures,
	savedLinearFeatures,
} from "./linear"
import { HubRequest, type ProviderEnv, type ProviderReturn, type StatusAnswer } from "./provider"

// The Linear card's state changes, as the Linear module's update.

type Env = ProviderEnv<LinearIntegrationStatus>
type Return = ProviderReturn<LinearCardModel, LinearMessage>

/** A switch flips on screen at once and saves; a second toggle waits for the first save. */
const toggledFeature = (model: LinearCardModel, env: Env, flag: typeof LinearFeatureFlag.Type): Return => {
	const saved = savedLinearFeatures(successOf(env.status.data))
	const step = toggledSwitches(model.features, saved, (switches) => ({
		...switches,
		[flag]: !switches[flag],
	}))
	return {
		model: { ...model, features: step.state },
		commands: step.save === null ? [] : [SaveLinearFeatures({ flag, enabled: step.save[flag] })],
	}
}

export const update = (model: LinearCardModel, message: LinearMessage, env: Env): Return =>
	LinearMessage.match<Return>(message, {
		ToggledFeature: ({ flag }) => toggledFeature(model, env, flag),
		CompletedFeatures: ({ failure }) => ({
			model: { ...model, features: completedSwitches(model.features, failure?.message ?? null) },
			requests: [HubRequest.readStatus("Supersede")],
		}),
	})

/** Only the current answer settles the switches: a superseded read predates the save. */
export const statusAnswered = (
	model: LinearCardModel,
	_env: Env,
	answer: StatusAnswer<LinearIntegrationStatus>,
): Return => ({ model: answer.isCurrent ? { ...model, features: settledSwitches(model.features) } : model })
