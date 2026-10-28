import { BillingCustomer } from "@maple/domain/http"
import { V2ApiKey } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { LoadFailure } from "../../data/load-failure"
import { SettingsSearch, settingsTabValues } from "../../route/search"
import * as Ai from "./ai/model"
import * as Billing from "./billing/model"
import * as Members from "./members/model"
import * as General from "./general/model"
import * as DataPlatform from "./data-platform/model"
import * as AuditLog from "./audit-log/model"
import * as Automation from "./automation/model"
import * as Ingestion from "./ingestion/model"
import * as Keys from "./keys/model"
import * as Mcp from "./mcp/model"
import * as SetupHealth from "./setup-health/model"

// `/settings`: the nav rail and the active tab's section.

/** What `useVisibleSettingsSections` reads from the session: whether the member administers the org. */
export const SessionInfo = Schema.Struct({
	isAdmin: Schema.Boolean,
	userId: Schema.NullOr(Schema.String),
	/** `useOrganizationFeatureFlags().flags.aiAutoTriage`: Clerk org metadata; on self-hosted. */
	hasAiAutoTriage: Schema.Boolean,
	/** The `ingestRules` rollout flag: the Ingestion tab shows ingest rules only where the gateway applies them. */
	hasIngestRules: Schema.optionalKey(Schema.Boolean),
})
export const SessionData = AsyncData.Schema(SessionInfo, LoadFailure)
/** `billingCustomerAtom`: the nav's data-platform gate and the Billing tab read the one customer. */
export const CustomerData = AsyncData.Schema(BillingCustomer, LoadFailure)

/** One tab's state. A tab switch keeps the one left in `kept`, so coming back repaints its data. */
export const TabModel = Schema.Union([
	Schema.TaggedStruct("Mcp", { model: Mcp.Model }),
	Schema.TaggedStruct("Keys", { model: Keys.Model }),
	Schema.TaggedStruct("Ingestion", { model: Ingestion.Model }),
	Schema.TaggedStruct("SetupHealth", { model: SetupHealth.Model }),
	Schema.TaggedStruct("Ai", { model: Ai.Model }),
	Schema.TaggedStruct("Automation", { model: Automation.Model }),
	Schema.TaggedStruct("AuditLog", { model: AuditLog.Model }),
	Schema.TaggedStruct("DataPlatform", { model: DataPlatform.Model }),
	Schema.TaggedStruct("General", { model: General.Model }),
	Schema.TaggedStruct("Members", { model: Members.Model }),
	Schema.TaggedStruct("Billing", { model: Billing.Model }),
	/** A tab whose section is not ported yet. */
	Schema.TaggedStruct("Unported", { tab: Schema.String }),
])
export type TabModel = typeof TabModel.Type

export const Model = Schema.Struct({
	search: SettingsSearch,
	/** The clock at entry, for relative times. */
	nowMs: Schema.Number,
	session: SessionData.schema,
	customer: CustomerData.schema,
	/** The `api_keys` shape while a tab reads it, `null` before its first answer. */
	apiKeys: Schema.NullOr(Schema.Array(V2ApiKey)),
	/** The `api_keys` shape failed before its first answer (`useCollectionLoadFailed`). */
	isApiKeysLoadFailed: Schema.Boolean,
	/** A `?tab=` deep link the viewer could not open; its note outlives the URL rewrite. */
	deniedTab: Schema.NullOr(Schema.Literals(settingsTabValues)),
	/** `null` until the active tab is known (the session gates it in Clerk mode). */
	tab: Schema.NullOr(TabModel),
	/** Tabs left during this visit, one per tab: they still take their answers, and revalidate on return. */
	kept: Schema.Array(TabModel),
})
export type Model = typeof Model.Type
