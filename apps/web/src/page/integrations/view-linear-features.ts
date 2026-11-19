import type { LinearIntegrationStatus } from "@maple/domain/http"
import { INTEGRATION_FEATURES } from "@maple/domain/integration-features"
import { Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { type FeatureRow, featurePanel } from "../kit/feature-list"
import { shownSwitches } from "./feature-switches"
import { LinearMessage, savedLinearFeatures } from "./linear"
import { Message } from "./message"
import { manageLock, type Model } from "./model"

// What Maple does in Linear, one switch per feature, on the connected card.

type H = HtmlBuilder<Message>

const rows = (model: Model, status: LinearIntegrationStatus): ReadonlyArray<FeatureRow<Message>> => {
	const state = model.linearCard.features
	const shown = shownSwitches(state, savedLinearFeatures(status))
	return Arr.map(INTEGRATION_FEATURES.linear, (spec) => {
		const flag = `${spec.id}Enabled` as const
		return {
			spec,
			isChecked: shown[flag],
			isDisabled: state.isSaving,
			onToggle: Message.GotLinearMessage({ message: LinearMessage.ToggledFeature({ flag }) }),
		}
	})
}

/** The connected card's panel. */
export const linearFeaturePanel = (h: H, model: Model, status: LinearIntegrationStatus): Html =>
	featurePanel(h, {
		idPrefix: "linear-feature",
		title: "What Maple does in Linear",
		rows: rows(model, status),
		error: model.linearCard.features.error,
		lockReason: manageLock(model),
	})
