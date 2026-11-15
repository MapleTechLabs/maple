import { LinearFeatureSettingsRequest, type LinearIntegrationStatus } from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure, toLoadFailure } from "@maple/views/data/load-failure"
import { MapleInternalApiClient } from "../../platform/api-clients"
import { FeatureSwitchesModel, initFeatureSwitches } from "./feature-switches"

// The Linear card's own state: the feature switches, each toggle saved at once.

/** The `INTEGRATION_FEATURES.linear` switches, as the card edits them. */
export const LinearFeatureSwitches = Schema.Struct({
	openIssuesEnabled: Schema.Boolean,
	updateCommentsEnabled: Schema.Boolean,
	reopenIssuesEnabled: Schema.Boolean,
	resolveCommentsEnabled: Schema.Boolean,
})
export type LinearFeatureSwitches = typeof LinearFeatureSwitches.Type
export const LinearFeatureFlag = Schema.Literals([
	"openIssuesEnabled",
	"updateCommentsEnabled",
	"reopenIssuesEnabled",
	"resolveCommentsEnabled",
])

/** The switches as saved; an older API that sends none has every one on. */
export const savedLinearFeatures = (status: LinearIntegrationStatus | null): LinearFeatureSwitches => ({
	openIssuesEnabled: status?.features?.openIssuesEnabled ?? true,
	updateCommentsEnabled: status?.features?.updateCommentsEnabled ?? true,
	reopenIssuesEnabled: status?.features?.reopenIssuesEnabled ?? true,
	resolveCommentsEnabled: status?.features?.resolveCommentsEnabled ?? true,
})

/** The Linear module's own messages; the hub carries them in `GotLinearMessage`. */
export const LinearMessage = defineMessageUnion({
	ToggledFeature: { flag: LinearFeatureFlag },
	CompletedFeatures: { failure: Schema.NullOr(LoadFailure) },
})
export type LinearMessage = typeof LinearMessage.Type

export const LinearCardModel = Schema.Struct({ features: FeatureSwitchesModel(LinearFeatureSwitches) })
export type LinearCardModel = typeof LinearCardModel.Type

export const initLinearCard = (): LinearCardModel => ({ features: initFeatureSwitches })

/** `linearFeatures` with only the toggled switch, so a stale tab never rewrites the others. */
export const SaveLinearFeatures = Command.define("SaveLinearFeatures", {
	args: { flag: LinearFeatureFlag, enabled: Schema.Boolean },
	messages: [LinearMessage.CompletedFeatures],
	execute: ({ flag, enabled }) =>
		Effect.gen(function* () {
			const client = yield* MapleInternalApiClient
			yield* client.integrations.linearFeatures({
				payload: new LinearFeatureSettingsRequest({ [flag]: enabled }),
			})
		}).pipe(
			Effect.match({
				onFailure: (error) => LinearMessage.CompletedFeatures({ failure: toLoadFailure(error) }),
				onSuccess: () => LinearMessage.CompletedFeatures({ failure: null }),
			}),
		),
})
