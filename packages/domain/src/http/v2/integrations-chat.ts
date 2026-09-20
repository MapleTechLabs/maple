import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Schema } from "effect"
import {
	IntegrationsConfigurationError,
	IntegrationsNotFoundError,
	IntegrationsPersistenceError,
	IntegrationsValidationError,
} from "../integrations"
import { ChatConnectorId, ChatWorkspaceId } from "../../primitives"
import { AuthorizationV2 } from "./auth"
import { wireExample, Timestamp } from "./envelopes"
import { V2CallbackHostUnavailable, V2InsufficientPermissions } from "./errors"
import { publicErrors } from "./public-error"
import { PublicId, PublicIdPrefixes } from "./public-id"

// The chat-platform surface: one contract for every chat platform Maple can
// connect to. The platform is a value (`connector`), never a path segment or a
// field name, so a new one ships without touching this file.

/** `chatw_…` public ID ⇄ internal `ChatWorkspaceId` (raw UUID). */
export const ChatWorkspacePublicId = PublicId(PublicIdPrefixes.chatWorkspace, ChatWorkspaceId)

/** Placeholder id for the docs: which connectors exist is a deployment fact. */
const CONNECTOR_EXAMPLE = Schema.decodeSync(ChatConnectorId)("chatapp")

const connectorField = ChatConnectorId.annotate({
	description: "The chat platform this belongs to, e.g. the id of one of Maple's chat connectors.",
	examples: [CONNECTOR_EXAMPLE],
})

/**
 * Connector-defined settings as a flat string map. The keys a connector accepts
 * are the `key`s of its manifest's settings fields, and the connector validates
 * the values — an unknown key or a malformed value is a 400, not a stored
 * surprise.
 */
const settingsField = Schema.Record(Schema.String, Schema.String).annotate({
	description:
		"Connector-defined settings for this workspace. Keys are the connector's own setting keys; values are always strings. Omitted keys are unset.",
	examples: [{ approver_role_id: "123456789012345678" }],
})

const chatWorkspaceExample = {
	id: "chatw_YofPTrK9782DWwcnXhpcCw",
	object: "chat_workspace",
	connector: "chatapp",
	external_workspace_id: "123456789012345678",
	name: "Acme Engineering",
	settings: { approver_role_id: "987654321098765432" },
	created_at: "2026-09-01T12:00:00.000Z",
} as const

export const V2ChatWorkspace = Schema.Struct({
	id: ChatWorkspacePublicId,
	object: Schema.Literal("chat_workspace").annotate({
		description: 'The object type — always `"chat_workspace"`.',
		examples: ["chat_workspace"],
	}),
	connector: connectorField,
	external_workspace_id: Schema.String.annotate({
		description: "The chat platform's own id for the workspace (a server, team or tenant id).",
		examples: ["123456789012345678"],
	}),
	name: Schema.String.annotate({
		description: "The workspace name as the platform reported it when it was linked.",
		examples: ["Acme Engineering"],
	}),
	settings: settingsField,
	created_at: Timestamp.annotate({ description: "When the workspace was linked to this organization." }),
}).annotate({
	identifier: "ChatWorkspace",
	title: "Chat workspace",
	description:
		"A chat workspace linked to your organization. The Maple bot answers any member of the workspace on your organization's behalf — there is no per-user link — and the writes it proposes are approved inside the chat platform.",
	examples: [wireExample(chatWorkspaceExample)],
})
export type V2ChatWorkspace = Schema.Schema.Type<typeof V2ChatWorkspace>

export const V2ChatConnector = Schema.Struct({
	id: ChatConnectorId.annotate({
		description: "The connector's id, as used in the install path.",
		examples: [CONNECTOR_EXAMPLE],
	}),
	object: Schema.Literal("chat_connector").annotate({
		description: 'The object type — always `"chat_connector"`.',
	}),
	name: Schema.String.annotate({
		description: "Display name of the chat platform.",
		examples: ["Chat App"],
	}),
	available: Schema.Boolean.annotate({
		description:
			"Whether this Maple deployment is configured to install the connector. `false` means the deployment is missing the connector's credentials — existing workspaces keep working, but no new one can be linked.",
		examples: [true],
	}),
	workspaces: Schema.Array(V2ChatWorkspace).annotate({
		description: "The workspaces your organization has linked through this connector.",
	}),
}).annotate({
	identifier: "ChatConnector",
	title: "Chat connector",
	description: "A chat platform Maple can connect to, and your organization's workspaces on it.",
	examples: [
		wireExample({
			id: "chatapp",
			object: "chat_connector",
			name: "Chat App",
			available: true,
			workspaces: [chatWorkspaceExample],
		}),
	],
})
export type V2ChatConnector = Schema.Schema.Type<typeof V2ChatConnector>

export const V2ChatConnectorList = Schema.Struct({
	object: Schema.Literal("chat_connector_list").annotate({
		description: 'The object type — always `"chat_connector_list"`.',
	}),
	data: Schema.Array(V2ChatConnector).annotate({
		description: "Every chat connector this Maple deployment ships.",
	}),
}).annotate({
	identifier: "ChatConnectorList",
	title: "Chat connector list",
	description:
		"The chat connectors Maple ships, each with your organization's linked workspaces. Not the standard `{ object: \"list\", … }` envelope: the set is the deployment's own connector registry, so there is nothing to paginate.",
	examples: [
		wireExample({
			object: "chat_connector_list",
			data: [
				{
					id: "chatapp",
					object: "chat_connector",
					name: "Chat App",
					available: true,
					workspaces: [chatWorkspaceExample],
				},
			],
		}),
	],
})
export type V2ChatConnectorList = Schema.Schema.Type<typeof V2ChatConnectorList>

export const V2ChatInstallResponse = Schema.Struct({
	object: Schema.Literal("chat_connector.install").annotate({
		description: 'The object type — always `"chat_connector.install"`.',
	}),
	url: Schema.String.annotate({
		description:
			"The chat platform's authorization URL to redirect the user to. On approval the platform redirects back to Maple, which links the workspace.",
		examples: ["https://chat.example.com/oauth2/authorize?client_id=123&state=abc"],
	}),
}).annotate({
	identifier: "ChatInstall",
	title: "Chat install response",
	description: "The authorization URL that begins linking a chat workspace.",
	examples: [
		wireExample({
			object: "chat_connector.install",
			url: "https://chat.example.com/oauth2/authorize?client_id=123&state=abc",
		}),
	],
})
export type V2ChatInstallResponse = Schema.Schema.Type<typeof V2ChatInstallResponse>

export const V2ChatWorkspaceUpdateParams = Schema.Struct({
	settings: settingsField,
}).annotate({
	identifier: "ChatWorkspaceUpdateParams",
	title: "Chat workspace update parameters",
	description:
		"Request body for updating a linked workspace's settings. The record replaces the stored settings wholesale, so send every key you want to keep; a blank value unsets its key.",
	examples: [wireExample({ settings: { approver_role_id: "987654321098765432" } })],
})
export type V2ChatWorkspaceUpdateParams = Schema.Schema.Type<typeof V2ChatWorkspaceUpdateParams>

export const V2ChatWorkspaceDeleteResponse = Schema.Struct({
	id: ChatWorkspacePublicId,
	object: Schema.Literal("chat_workspace").annotate({
		description: 'The object type — always `"chat_workspace"`.',
	}),
	deleted: Schema.Literal(true).annotate({
		description: "Always `true` — the workspace is no longer linked.",
	}),
}).annotate({
	identifier: "ChatWorkspaceDeleteResponse",
	title: "Chat workspace delete response",
	description: "Confirmation that a chat workspace was unlinked.",
	examples: [wireExample({ id: "chatw_YofPTrK9782DWwcnXhpcCw", object: "chat_workspace", deleted: true })],
})
export type V2ChatWorkspaceDeleteResponse = Schema.Schema.Type<typeof V2ChatWorkspaceDeleteResponse>

const [chatConfiguration, chatNotFound, chatPersistence, chatValidation] = publicErrors(
	IntegrationsConfigurationError,
	IntegrationsNotFoundError,
	IntegrationsPersistenceError,
	IntegrationsValidationError,
)

export class V2ChatIntegrationsApiGroup extends HttpApiGroup.make("chatIntegration")
	.add(
		HttpApiEndpoint.get("connectors", "/chat_connectors", {
			success: V2ChatConnectorList,
			error: [chatPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listChatConnectors",
				summary: "List chat connectors",
				description:
					"Returns every chat connector this Maple deployment ships, whether it is configured, and the workspaces your organization has linked through it. Requires the `integrations:read` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.post("install", "/chat_connectors/:connector/install", {
			params: { connector: ChatConnectorId },
			success: V2ChatInstallResponse,
			error: [
				V2InsufficientPermissions.schema,
				V2CallbackHostUnavailable.schema,
				chatNotFound,
				chatConfiguration,
				chatPersistence,
			],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "installChatConnector",
				summary: "Begin linking a chat workspace",
				description:
					"Returns the chat platform's authorization URL to redirect the user to. Running it again links an additional workspace; it does not replace the existing ones. Requires an org-admin role and the `integrations:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.patch("updateWorkspace", "/chat_workspaces/:id", {
			params: { id: ChatWorkspacePublicId },
			payload: V2ChatWorkspaceUpdateParams,
			success: V2ChatWorkspace,
			error: [V2InsufficientPermissions.schema, chatNotFound, chatValidation, chatPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "updateChatWorkspace",
				summary: "Update a chat workspace",
				description:
					"Replaces a linked workspace's connector-defined settings. Requires an org-admin role and the `integrations:write` scope.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.delete("deleteWorkspace", "/chat_workspaces/:id", {
			params: { id: ChatWorkspacePublicId },
			success: V2ChatWorkspaceDeleteResponse,
			error: [V2InsufficientPermissions.schema, chatNotFound, chatPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "deleteChatWorkspace",
				summary: "Unlink a chat workspace",
				description:
					"Unlinks a chat workspace: the bot stops answering in it immediately. Removing the bot from the workspace itself is done on the chat platform. Requires an org-admin role and the `integrations:write` scope.",
			}),
		),
	)
	.prefix("/v2/integrations")
	.middleware(AuthorizationV2)
	.annotateMerge(
		OpenApi.annotations({
			title: "Chat Integrations",
			description:
				"Link chat workspaces to your organization. The Maple bot answers questions from any member of a linked workspace and asks for approval there before it writes anything.",
		}),
	) {}
