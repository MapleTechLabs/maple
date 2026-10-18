import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { accountTabValues, AccountSearch } from "../../../route/search"
import * as Profile from "./profile/model"

// `/account` (apps/web/src/routes/account.tsx): the account nav rail and the active tab. Clerk only;
// self-hosted has a single root pseudo-user and redirects to `/settings`.

/** The active tab's state; a tab switch drops the old one (React unmounts the section). */
export const TabModel = Schema.Union([
	Schema.TaggedStruct("Profile", { model: Profile.Model }),
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
})
export type Message = typeof Message.Type
