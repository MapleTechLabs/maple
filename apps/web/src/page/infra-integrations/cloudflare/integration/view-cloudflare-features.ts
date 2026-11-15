import type { CloudflareIntegrationStatus } from "@maple/domain/http"
import { INTEGRATION_FEATURES } from "@maple/domain/integration-features"
import { Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { type FeatureRow, featureList, featurePanel } from "../../../kit/feature-list"
import { shownSwitches } from "../../../integrations/feature-switches"
import type { Message } from "../../../integrations/message"
import type { Model } from "../../../integrations/model"
import { CloudflareMessage } from "./cloudflare"
import { savedCloudflareFeatures } from "./update-cloudflare"
import { toHub } from "./view-cloudflare-zones"

// What the Cloudflare grant collects, one switch per feature: on the card and in the connect flow.

type H = HtmlBuilder<Message>

const rows = (model: Model, status: CloudflareIntegrationStatus): ReadonlyArray<FeatureRow<Message>> => {
	const state = model.cloudflareCard.features
	const shown = shownSwitches(state, savedCloudflareFeatures(status))
	return Arr.map(INTEGRATION_FEATURES.cloudflare, (spec) => {
		const flag = `${spec.id}Enabled` as const
		return {
			spec,
			isChecked: shown[flag],
			isDisabled: state.isSaving,
			onToggle: toHub(CloudflareMessage.ToggledFeature({ flag })),
		}
	})
}

/** The connected card's panel. */
export const cloudflareFeaturePanel = (h: H, model: Model, status: CloudflareIntegrationStatus): Html =>
	featurePanel(h, {
		idPrefix: "cloudflare-feature",
		rows: rows(model, status),
		error: model.cloudflareCard.features.error,
	})

/** The connect flow's Choose data list. */
export const cloudflareFeatureChoice = (h: H, model: Model, status: CloudflareIntegrationStatus): Html =>
	featureList(h, { idPrefix: "cloudflare-choose", rows: rows(model, status) })
