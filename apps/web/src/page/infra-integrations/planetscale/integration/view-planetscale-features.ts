import type { V2PlanetScaleIntegration } from "@maple/domain/http/v2"
import { INTEGRATION_FEATURES } from "@maple/domain/integration-features"
import { Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { type FeatureRow, featureList, featurePanel } from "../../../kit/feature-list"
import { shownSwitches } from "../../../integrations/feature-switches"
import type { Message } from "../../../integrations/message"
import { type Model, manageLock } from "../../../integrations/model"
import { PlanetscaleMessage, savedPlanetscaleFeatures } from "./planetscale"
import { toHub } from "./view-planetscale-parts"

// What the PlanetScale connection collects, one switch per feature: on the card and in Choose data.

type H = HtmlBuilder<Message>

const rows = (model: Model, status: V2PlanetScaleIntegration): ReadonlyArray<FeatureRow<Message>> => {
	const state = model.planetscaleCard.features
	const shown = shownSwitches(state, savedPlanetscaleFeatures(status))
	return Arr.map(INTEGRATION_FEATURES.planetscale, (spec) => {
		const flag = `${spec.id}Enabled` as const
		return {
			spec,
			isChecked: shown[flag],
			isDisabled: state.isSaving,
			onToggle: toHub(PlanetscaleMessage.ToggledFeature({ flag })),
		}
	})
}

/** The connected card's panel. */
export const planetscaleFeaturePanel = (h: H, model: Model, status: V2PlanetScaleIntegration): Html =>
	featurePanel(h, {
		idPrefix: "planetscale-feature",
		rows: rows(model, status),
		error: model.planetscaleCard.features.error,
		lockReason: manageLock(model),
	})

/** The connect flow's list, once the organization is saved. */
export const planetscaleFeatureChoice = (h: H, model: Model, status: V2PlanetScaleIntegration): Html =>
	featureList(h, {
		idPrefix: "planetscale-choose",
		rows: rows(model, status),
		lockReason: manageLock(model),
	})
