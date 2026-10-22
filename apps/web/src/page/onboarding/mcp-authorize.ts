import { Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { load } from "foldkit/navigation"
import { defineTaggedUnion } from "foldkit/schema"
import { modifyFields } from "foldkit/struct"
import { MapleApiClient } from "../../platform/api-clients"
import type { Resources } from "../../platform/resources"
import { endpointMessage, localeTimeOf } from "./request"

// `/mcp-authorize`: OAuth consent for an MCP client.

// MODEL

export const AuthorizationInfo = Schema.Struct({
	clientName: Schema.String,
	/** `redirectTarget(redirectUri)`: the host, or `scheme:path` for a custom scheme. */
	returnsTo: Schema.String,
	expiresAtLabel: Schema.String,
})
export type AuthorizationInfo = typeof AuthorizationInfo.Type

export const State = defineTaggedUnion({
	Loading: {},
	Ready: { info: AuthorizationInfo },
	Redirecting: {},
	Failed: { message: Schema.String },
})
export type State = typeof State.Type

export const Model = Schema.TaggedStruct("McpAuthorize", {
	requestId: Schema.NullOr(Schema.String),
	state: State,
})
export type Model = typeof Model.Type

const Action = Schema.Literals(["approve", "deny"])

// MESSAGE

export const Message = defineMessageUnion({
	SucceededInspectMcpAuthorization: { info: AuthorizationInfo, isPending: Schema.Boolean },
	FailedInspectMcpAuthorization: { message: Schema.String },
	ClickedDecision: { action: Action },
	SucceededDecideMcpAuthorization: { redirectUri: Schema.String },
	FailedDecideMcpAuthorization: { message: Schema.String },
	CompletedReturnToClient: {},
})
export type Message = typeof Message.Type

// COMMAND

/** Custom schemes (`cursor://...`) have an empty host, so those show `scheme:path`. */
const redirectTarget = (uri: string): string => {
	if (!URL.canParse(uri)) return uri
	const url = new URL(uri)
	return url.host === "" ? `${url.protocol}${url.pathname}` : url.host
}

/** `inspectMcpAuthorization`: `GET /api/auth/mcp/oauth/authorization/:requestId`. */
export const InspectMcpAuthorization = Command.define("InspectMcpAuthorization", {
	args: { requestId: Schema.String },
	messages: [Message.SucceededInspectMcpAuthorization, Message.FailedInspectMcpAuthorization],
	execute: ({ requestId }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiClient
			const response = yield* client.auth.mcpOAuthAuthorizationInspect({ params: { requestId } })
			const expiresAtLabel = yield* localeTimeOf(response.expiresAt)
			const returnsTo = yield* Effect.sync(() => redirectTarget(response.redirectUri))
			return Message.SucceededInspectMcpAuthorization({
				info: { clientName: response.clientName, returnsTo, expiresAtLabel },
				isPending: response.status === "pending",
			})
		}).pipe(
			Effect.catch((error) =>
				Effect.succeed(
					Message.FailedInspectMcpAuthorization({
						message: endpointMessage(
							error,
							"This MCP authorization request is invalid or expired.",
						),
					}),
				),
			),
		),
})

/** `decideMcpAuthorization`: `POST .../approve|deny`, answered with where to send the user. */
export const DecideMcpAuthorization = Command.define("DecideMcpAuthorization", {
	args: { requestId: Schema.String, action: Action },
	messages: [Message.SucceededDecideMcpAuthorization, Message.FailedDecideMcpAuthorization],
	execute: ({ requestId, action }) =>
		Effect.gen(function* () {
			const client = yield* MapleApiClient
			const result = yield* action === "approve"
				? client.auth.mcpOAuthAuthorizationApprove({ params: { requestId } })
				: client.auth.mcpOAuthAuthorizationDeny({ params: { requestId } })
			return Message.SucceededDecideMcpAuthorization({ redirectUri: result.redirectUri })
		}).pipe(
			Effect.catch((error) =>
				Effect.succeed(
					Message.FailedDecideMcpAuthorization({
						message: endpointMessage(error, `Unable to ${action} MCP access.`),
					}),
				),
			),
		),
})

/** `window.location.assign(result.redirectUri)`: back to the MCP client, off this origin. */
export const ReturnToClient = Command.define("ReturnToClient", {
	args: { href: Schema.String },
	messages: [Message.CompletedReturnToClient],
	execute: ({ href }) => load(href).pipe(Effect.as(Message.CompletedReturnToClient())),
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message, Resources>

const failed = (model: Model, message: string): UpdateReturn => ({
	model: modifyFields(model, { state: () => State.Failed({ message }) }),
})

/** The mount effect: an incomplete link fails at once, otherwise the request is inspected. */
export const init = (requestId: string | undefined): UpdateReturn => {
	const model: Model = { _tag: "McpAuthorize", requestId: requestId || null, state: State.Loading() }
	return model.requestId === null
		? failed(model, "This authorization link is incomplete.")
		: { model, commands: [InspectMcpAuthorization({ requestId: model.requestId })] }
}

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		SucceededInspectMcpAuthorization: ({ info, isPending }) =>
			model.state._tag !== "Loading"
				? { model }
				: isPending
					? { model: modifyFields(model, { state: () => State.Ready({ info }) }) }
					: failed(model, "This authorization request has already been used."),
		FailedInspectMcpAuthorization: ({ message: failure }) =>
			model.state._tag === "Loading" ? failed(model, failure) : { model },
		// The in-flight guard: one decision, taken from the ready card.
		ClickedDecision: ({ action }) =>
			model.requestId !== null && model.state._tag === "Ready"
				? {
						model: modifyFields(model, { state: () => State.Redirecting() }),
						commands: [DecideMcpAuthorization({ requestId: model.requestId, action })],
					}
				: { model },
		SucceededDecideMcpAuthorization: ({ redirectUri }) => ({
			model,
			commands: [ReturnToClient({ href: redirectUri })],
		}),
		FailedDecideMcpAuthorization: ({ message: failure }) => failed(model, failure),
		CompletedReturnToClient: () => ({ model }),
	})
