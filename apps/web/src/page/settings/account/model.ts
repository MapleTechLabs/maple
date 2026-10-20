import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { accountTabValues, AccountSearch } from "../../../route/search"
import * as Profile from "./profile/model"
import * as EmailPreferences from "./email-preferences/model"
import * as TwoFactor from "./two-factor/model"
import * as Sessions from "./sessions/model"
import * as Connections from "./connections/model"
import * as Passkeys from "./passkeys/model"
import * as Emails from "./emails/model"
import * as Password from "./password/model"

// `/account`: the account nav rail and the active tab. Clerk only; self-hosted has a single root pseudo-user
// and redirects to `/settings`.

/** The active tab's state; a tab switch drops the old one (the section unmounts). */
export const TabModel = Schema.Union([
	Schema.TaggedStruct("Profile", { model: Profile.Model }),
	Schema.TaggedStruct("Password", { model: Password.Model }),
	Schema.TaggedStruct("Emails", { model: Emails.Model }),
	Schema.TaggedStruct("Passkeys", { model: Passkeys.Model }),
	Schema.TaggedStruct("Connections", { model: Connections.Model }),
	Schema.TaggedStruct("Sessions", { model: Sessions.Model }),
	Schema.TaggedStruct("TwoFactor", { model: TwoFactor.Model }),
	Schema.TaggedStruct("EmailPreferences", { model: EmailPreferences.Model }),
	/** A tab whose section is not ported yet. */
	Schema.TaggedStruct("Unported", { tab: Schema.String }),
])
export type TabModel = typeof TabModel.Type

export const Model = Schema.Struct({
	search: AccountSearch,
	/** The clock at entry, for relative times. */
	nowMs: Schema.Number,
	/** `null` while redirecting (self-hosted). */
	tab: Schema.NullOr(TabModel),
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	ClickedTab: { tab: Schema.Literals(accountTabValues) },
	GotProfileMessage: { message: Profile.Message },
	GotEmailPreferencesMessage: { message: EmailPreferences.Message },
	GotTwoFactorMessage: { message: TwoFactor.Message },
	GotSessionsMessage: { message: Sessions.Message },
	GotConnectionsMessage: { message: Connections.Message },
	GotPasskeysMessage: { message: Passkeys.Message },
	GotEmailsMessage: { message: Emails.Message },
	GotPasswordMessage: { message: Password.Message },
})
export type Message = typeof Message.Type
