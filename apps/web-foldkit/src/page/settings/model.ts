import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { LoadFailure } from "../../data/load-failure"
import { SettingsSearch } from "../../route/search"
import * as Mcp from "./mcp/model"

// `/settings` (apps/web/src/routes/settings.tsx): the nav rail and the active tab's section.

/** What `useVisibleSettingsSections` reads from the session: whether the member administers the org. */
export const SessionData = AsyncData.Schema(Schema.Struct({ isAdmin: Schema.Boolean }), LoadFailure)
/** `useMapleCustomer()`: whether the org bought the bring-your-own-cloud add-on. */
export const CustomerData = AsyncData.Schema(Schema.Struct({ hasByoc: Schema.Boolean }), LoadFailure)

/** The active tab's state; a tab switch drops the old one (React unmounts the section). */
export const TabModel = Schema.Union([
	Schema.TaggedStruct("Mcp", { model: Mcp.Model }),
	/** A tab whose section is not ported yet. */
	Schema.TaggedStruct("Unported", { tab: Schema.String }),
])
export type TabModel = typeof TabModel.Type

export const Model = Schema.Struct({
	search: SettingsSearch,
	/** The clock at entry, for relative times (legacy reads `Date.now()` at render). */
	nowMs: Schema.Number,
	session: SessionData.schema,
	customer: CustomerData.schema,
	/** `null` until the active tab is known (the session gates it in Clerk mode). */
	tab: Schema.NullOr(TabModel),
})
export type Model = typeof Model.Type
