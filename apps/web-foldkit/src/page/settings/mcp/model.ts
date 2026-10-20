import { McpToolCatalogEntry } from "@maple/domain/http"
import { V2McpConnection } from "@maple/domain/http/v2"
import { MCP_CLIENTS } from "../../../components/settings/mcp-client-config"
import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { LoadFailure } from "../../../data/load-failure"
import * as CopyButton from "../../../ui/copy-button"
import * as Dialog from "../../../ui/dialog"
import * as Tabs from "../../../ui/tabs"
import * as CreateKey from "../keys/create-dialog"

// `McpSection`: connect a client, the connected OAuth clients and the tool catalog. Shared by
// `/settings?tab=mcp` and `/mcp`.

export const ConnectionsData = AsyncData.Schema(Schema.Array(V2McpConnection), LoadFailure)
export const ToolsData = AsyncData.Schema(Schema.Array(McpToolCatalogEntry), LoadFailure)

export const Model = Schema.Struct({
	client: Tabs.Model,
	serverUrlCopy: CopyButton.Model,
	/** Snippet copy states by `<client>:<index>`; a Base UI tab panel unmounts, so they reset on switch. */
	snippetCopies: Schema.Record(Schema.String, CopyButton.Model),
	/** The MCP key the dialog created, spliced into the snippets. */
	createdSecret: Schema.NullOr(Schema.String),
	createKey: CreateKey.Model,
	connections: ConnectionsData.schema,
	revoking: Schema.NullOr(V2McpConnection),
	revokeDialog: Dialog.Model,
	isRevoking: Schema.Boolean,
	tools: ToolsData.schema,
	toolSearch: Schema.String,
	/** Groups whose open state differs from the default (the first three open). */
	flippedGroups: Schema.Array(Schema.String),
	expandedGroups: Schema.Array(Schema.String),
})
export type Model = typeof Model.Type

export const CLIENT_VALUES = MCP_CLIENTS.map((client) => client.id)
export const CLIENT_LABELS = MCP_CLIENTS.map((client) => client.label)
