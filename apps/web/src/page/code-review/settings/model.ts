import {
	GithubIntegrationStatus,
	GithubPrReviewConfigResponse,
	GithubPrReviewSettingsResponse,
	PrReviewOrgSettings,
	VcsRepositoryId,
} from "@maple/domain/http"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { KeyedSchema } from "../../../data/keyed"
import { LoadFailure } from "../../../data/load-failure"
import * as Dialog from "../../../ui/dialog"
import * as Select from "../../../ui/select"
import * as RulesForm from "../rules-form/form"
import { RepoFilter, RepoListState } from "./repositories"

// `/code-review/settings`: the review model, the default rules and the
// repositories, each repository's own rules in a dialog.

export const SavePurpose = Schema.Literals(["model", "defaults"])
export type SavePurpose = typeof SavePurpose.Type

export const Model = Schema.Struct({
	settings: KeyedSchema(GithubPrReviewSettingsResponse, LoadFailure),
	githubStatus: KeyedSchema(GithubIntegrationStatus, LoadFailure),
	/** `useIsOrgAdmin`: always true self-hosted; the session's roles under Clerk. */
	isAdmin: Schema.Boolean,
	modelSelect: Select.Model,
	isSavingModel: Schema.Boolean,
	/** The settings as this tab has written them (in flight or queued); every save is built from it. */
	localSettings: Schema.NullOr(PrReviewOrgSettings),
	/** The settings row is written whole, so saves run one at a time: the one in flight, then the queue. */
	savingSettings: Schema.NullOr(SavePurpose),
	/** The settings the save in flight sent, and the last ones the server confirmed (null: the read). */
	sentSettings: Schema.NullOr(PrReviewOrgSettings),
	confirmedSettings: Schema.NullOr(PrReviewOrgSettings),
	queuedSaves: Schema.Array(Schema.Struct({ purpose: SavePurpose, label: Schema.String })),
	/** Built from the first settings answer, then kept in step with refetches. */
	defaultsForm: Schema.NullOr(RulesForm.Model),
	repoList: RepoListState,
	/**
	 * `RepositoryRow`'s optimistic switch and the server value it was flipped from: a fresh server
	 * value wins, an unchanged one keeps the switch where the user put it (`seenServer`).
	 */
	optimistic: Schema.Record(
		Schema.String,
		Schema.Struct({ isEnabled: Schema.Boolean, server: Schema.Boolean }),
	),
	busy: Schema.Array(Schema.String),
	dialog: Dialog.Model,
	configuring: Schema.NullOr(VcsRepositoryId),
	repoConfig: KeyedSchema(GithubPrReviewConfigResponse, LoadFailure),
	repoForm: Schema.NullOr(RulesForm.Model),
})
export type Model = typeof Model.Type

const result = <S extends Schema.Top>(schema: S) => ({
	key: Schema.String,
	result: Schema.Result(schema, LoadFailure),
})

export const Message = defineMessageUnion({
	CompletedFetchSettings: result(GithubPrReviewSettingsResponse),
	CompletedFetchStatus: result(GithubIntegrationStatus),
	CompletedFetchRepoConfig: result(GithubPrReviewConfigResponse),
	CompletedReadIsAdmin: { isAdmin: Schema.Boolean },
	ClickedRetrySettings: {},
	ClickedRetryStatus: {},
	GotModelSelectMessage: { message: Select.Message },
	CompletedSaveSettings: {
		purpose: SavePurpose,
		label: Schema.String,
		result: Schema.Result(Schema.Void, LoadFailure),
	},
	GotDefaultsFormMessage: { message: RulesForm.Message },
	ChangedRepoSearch: { value: Schema.String },
	PickedRepoFilter: { filter: RepoFilter },
	ClickedShowAllRepos: {},
	ToggledRepo: { repositoryId: VcsRepositoryId, fullName: Schema.String, isEnabled: Schema.Boolean },
	CompletedSetPrReview: {
		repositoryId: VcsRepositoryId,
		fullName: Schema.String,
		isEnabled: Schema.Boolean,
		result: Schema.Result(Schema.Void, LoadFailure),
	},
	ClickedConfigure: { repositoryId: VcsRepositoryId },
	GotDialogMessage: { message: Dialog.Message },
	GotRepoFormMessage: { message: RulesForm.Message },
	CompletedSaveRepoConfig: {
		repositoryId: VcsRepositoryId,
		fullName: Schema.String,
		result: Schema.Result(Schema.Void, LoadFailure),
	},
})
export type Message = typeof Message.Type
