import {
	GithubPrReviewConfigRequest,
	GithubPrReviewSettingsRequest,
	GithubSetPrReviewRequest,
	PrReviewOrgSettings,
	PrReviewRepositoryConfig,
	VcsRepositoryId,
} from "@maple/domain/http"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { MapleInternalApiClient } from "../../../platform/api-clients"
import { readIsAdmin } from "../../alerts/shared/commands"
import { Message, SavePurpose } from "./model"

type Api = typeof MapleInternalApiClient.Service

const call = <A, E, R>(run: (api: Api) => Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const api = yield* MapleInternalApiClient
		return yield* run(api)
	}).pipe(Effect.mapError(toLoadFailure), Effect.result)

export const FetchSettings = Command.define("FetchCodeReviewSettings", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchSettings],
	execute: ({ key }) =>
		Effect.map(
			call((api) => api.integrations.githubGetPrReviewSettings()),
			(result) => Message.CompletedFetchSettings({ key, result }),
		),
})

export const FetchStatus = Command.define("FetchCodeReviewSettingsStatus", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchStatus],
	execute: ({ key }) =>
		Effect.map(
			call((api) => api.integrations.githubStatus()),
			(result) => Message.CompletedFetchStatus({ key, result }),
		),
})

export const FetchRepoConfig = Command.define("FetchCodeReviewRepoConfig", {
	args: { key: Schema.String, repositoryId: VcsRepositoryId },
	messages: [Message.CompletedFetchRepoConfig],
	execute: ({ key, repositoryId }) =>
		Effect.map(
			call((api) => api.integrations.githubGetPrReviewConfig({ params: { repositoryId } })),
			(result) => Message.CompletedFetchRepoConfig({ key, result }),
		),
})

/** `useIsOrgAdmin` under Clerk: the session's roles. */
export const ReadIsAdmin = Command.define("ReadCodeReviewIsAdmin", {
	messages: [Message.CompletedReadIsAdmin],
	execute: Effect.map(readIsAdmin, (isAdmin) => Message.CompletedReadIsAdmin({ isAdmin })),
})

/** `githubSetPrReviewSettings`: the settings are one row, written whole. */
export const SaveSettings = Command.define("SaveCodeReviewSettings", {
	args: { purpose: SavePurpose, label: Schema.String, settings: PrReviewOrgSettings },
	messages: [Message.CompletedSaveSettings],
	execute: ({ purpose, label, settings }) =>
		Effect.map(
			call((api) =>
				Effect.asVoid(
					api.integrations.githubSetPrReviewSettings({
						payload: new GithubPrReviewSettingsRequest({ settings }),
					}),
				),
			),
			(result) => Message.CompletedSaveSettings({ purpose, label, result }),
		),
})

export const SetPrReview = Command.define("SetCodeReviewPrReview", {
	args: { repositoryId: VcsRepositoryId, fullName: Schema.String, isEnabled: Schema.Boolean },
	messages: [Message.CompletedSetPrReview],
	execute: ({ repositoryId, fullName, isEnabled }) =>
		Effect.map(
			call((api) =>
				Effect.asVoid(
					api.integrations.githubSetPrReview({
						params: { repositoryId },
						payload: new GithubSetPrReviewRequest({ enabled: isEnabled }),
					}),
				),
			),
			(result) => Message.CompletedSetPrReview({ repositoryId, fullName, isEnabled, result }),
		),
})

export const SaveRepoConfig = Command.define("SaveCodeReviewRepoConfig", {
	args: { repositoryId: VcsRepositoryId, fullName: Schema.String, config: PrReviewRepositoryConfig },
	messages: [Message.CompletedSaveRepoConfig],
	execute: ({ repositoryId, fullName, config }) =>
		Effect.map(
			call((api) =>
				Effect.asVoid(
					api.integrations.githubSetPrReviewConfig({
						params: { repositoryId },
						payload: new GithubPrReviewConfigRequest({ config }),
					}),
				),
			),
			(result) => Message.CompletedSaveRepoConfig({ repositoryId, fullName, result }),
		),
})

