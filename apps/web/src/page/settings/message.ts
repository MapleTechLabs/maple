import { BillingCustomer } from "@maple/domain/http"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "../../data/load-failure"
import { settingsTabValues } from "../../route/search"
import { ApiKeyRowSchema } from "@maple/web-data/collections/api-keys"
import { Message as AiMessage } from "./ai/model"
import { Message as BillingMessage } from "./billing/model"
import { Message as MembersMessage } from "./members/model"
import { Message as GeneralMessage } from "./general/model"
import { Message as DataPlatformMessage } from "./data-platform/model"
import { Message as AuditLogMessage } from "./audit-log/model"
import { Message as AutomationMessage } from "./automation/model"
import * as Ingestion from "./ingestion/message"
import * as Keys from "./keys/message"
import * as Mcp from "./mcp/message"
import { Message as SetupHealthMessage } from "./setup-health/model"
import { SessionInfo } from "./model"

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	CompletedFetchSession: { result: Schema.Result(SessionInfo, LoadFailure) },
	CompletedFetchCustomer: { result: Schema.Result(BillingCustomer, LoadFailure) },
	ClickedTab: { tab: Schema.Literals(settingsTabValues) },
	GotMcpMessage: { message: Mcp.Message },
	GotKeysMessage: { message: Keys.Message },
	GotIngestionMessage: { message: Ingestion.Message },
	GotSetupHealthMessage: { message: SetupHealthMessage },
	GotAiMessage: { message: AiMessage },
	GotBillingMessage: { message: BillingMessage },
	GotMembersMessage: { message: MembersMessage },
	GotGeneralMessage: { message: GeneralMessage },
	GotDataPlatformMessage: { message: DataPlatformMessage },
	GotAuditLogMessage: { message: AuditLogMessage },
	GotAutomationMessage: { message: AutomationMessage },
	/** The `api_keys` shape (Keys and the audit log's actor names), for the org it was read for. */
	UpdatedApiKeys: { orgId: Schema.String, rows: Schema.Array(ApiKeyRowSchema) },
	/** The `api_keys` shape gave up (or timed out) before its first answer. */
	FailedLoadApiKeys: { orgId: Schema.String },
})
export type Message = typeof Message.Type
