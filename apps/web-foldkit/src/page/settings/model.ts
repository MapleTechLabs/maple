import { V2ApiKey } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { LoadFailure } from "../../data/load-failure"
import { SettingsSearch } from "../../route/search"
import * as Ai from "./ai/model"
import * as DataPlatform from "./data-platform/model"
import * as AuditLog from "./audit-log/model"
import * as Automation from "./automation/model"
import * as Ingestion from "./ingestion/model"
import * as Keys from "./keys/model"
import * as Mcp from "./mcp/model"
import * as SetupHealth from "./setup-health/model"

// `/settings` (apps/web/src/routes/settings.tsx): the nav rail and the active tab's section.

/** What `useVisibleSettingsSections` reads from the session: whether the member administers the org. */
export const SessionInfo = Schema.Struct({ isAdmin: Schema.Boolean, userId: Schema.NullOr(Schema.String) })
export const SessionData = AsyncData.Schema(SessionInfo, LoadFailure)
/** `useMapleCustomer()`: whether the org bought the bring-your-own-cloud add-on. */
export const CustomerData = AsyncData.Schema(Schema.Struct({ hasByoc: Schema.Boolean }), LoadFailure)

/** The active tab's state; a tab switch drops the old one (React unmounts the section). */
export const TabModel = Schema.Union([
	Schema.TaggedStruct("Mcp", { model: Mcp.Model }),
	Schema.TaggedStruct("Keys", { model: Keys.Model }),
	Schema.TaggedStruct("Ingestion", { model: Ingestion.Model }),
	Schema.TaggedStruct("SetupHealth", { model: SetupHealth.Model }),
	Schema.TaggedStruct("Ai", { model: Ai.Model }),
	Schema.TaggedStruct("Automation", { model: Automation.Model }),
	Schema.TaggedStruct("AuditLog", { model: AuditLog.Model }),
	Schema.TaggedStruct("DataPlatform", { model: DataPlatform.Model }),
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
	/** The `api_keys` shape while a tab reads it, `null` before its first answer. */
	apiKeys: Schema.NullOr(Schema.Array(V2ApiKey)),
	/** `null` until the active tab is known (the session gates it in Clerk mode). */
	tab: Schema.NullOr(TabModel),
})
export type Model = typeof Model.Type
