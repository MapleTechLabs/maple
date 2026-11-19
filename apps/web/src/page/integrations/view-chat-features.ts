import type { V2ChatWorkspace } from "@maple/domain/http/v2"
import { INTEGRATION_FEATURES } from "@maple/domain/integration-features"
import { Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { type FeatureRow, featurePanel } from "../kit/feature-list"
import { ChatMessage, savedChatFeatures } from "./chat"
import { initFeatureSwitches, shownSwitches } from "./feature-switches"
import { Message } from "./message"
import { manageLock, type Model } from "./model"

// What the bot does in one linked workspace, one switch per feature, under its card.

type H = HtmlBuilder<Message>

const rows = (model: Model, workspace: V2ChatWorkspace): ReadonlyArray<FeatureRow<Message>> => {
	const card = model.chatCard
	const state = card.featuresWorkspaceId === workspace.id ? card.features : initFeatureSwitches
	const shown = shownSwitches(state, savedChatFeatures(workspace))
	return Arr.map(INTEGRATION_FEATURES.chat, (spec) => {
		const flag = `${spec.id}Enabled` as const
		return {
			spec,
			isChecked: shown[flag],
			isDisabled: card.features.isSaving,
			onToggle: Message.GotChatMessage({
				message: ChatMessage.ToggledFeature({ workspaceId: workspace.id, flag }),
			}),
		}
	})
}

/** A linked workspace's panel; a failed save shows on the workspace it was for. */
export const chatFeaturePanel = (h: H, model: Model, workspace: V2ChatWorkspace): Html =>
	featurePanel(h, {
		idPrefix: `chat-feature-${workspace.id}`,
		title: "What Maple does here",
		rows: rows(model, workspace),
		error: model.chatCard.featuresWorkspaceId === workspace.id ? model.chatCard.features.error : null,
		lockReason: manageLock(model),
	})
