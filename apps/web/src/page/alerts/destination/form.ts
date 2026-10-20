import { AlertDestinationType, ChatWorkspaceId } from "@maple/domain/http"
import type { DestinationFormState } from "@maple/web-data/alerts/form-utils"
import { Schema } from "effect"

/** `DestinationFormState` as Model data (`@maple/web-data/alerts/form-utils`). */
export const DestinationForm = Schema.Struct({
	type: AlertDestinationType,
	name: Schema.String,
	enabled: Schema.Boolean,
	webhookUrl: Schema.String,
	integrationKey: Schema.String,
	url: Schema.String,
	signingSecret: Schema.String,
	telegramBotToken: Schema.String,
	telegramChatId: Schema.String,
	hazelOrganizationId: Schema.String,
	hazelOrganizationName: Schema.String,
	hazelOrganizationLogoUrl: Schema.NullOr(Schema.String),
	hazelChannelId: Schema.String,
	hazelChannelName: Schema.String,
	memberUserIds: Schema.Array(Schema.String),
	chatWorkspaceId: Schema.NullOr(ChatWorkspaceId),
	chatConnector: Schema.String,
	chatChannelId: Schema.String,
	chatChannelName: Schema.String,
})
export type DestinationForm = typeof DestinationForm.Type

/** The web-data helpers take the mutable form; the Model holds the readonly one. */
export const toFormState = (form: DestinationForm): DestinationFormState => ({
	...form,
	memberUserIds: [...form.memberUserIds],
})

/** The text fields the dialog edits, by form key. */
export const TextField = Schema.Literals([
	"name",
	"webhookUrl",
	"integrationKey",
	"url",
	"signingSecret",
	"telegramBotToken",
	"telegramChatId",
])
export type TextField = typeof TextField.Type
