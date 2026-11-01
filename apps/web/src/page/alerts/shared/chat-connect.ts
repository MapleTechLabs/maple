import type { V2ChatConnector } from "@maple/domain/http/v2"
import { ChatConnectorId, type ChatWorkspaceId } from "@maple/domain/primitives"
import { Option, Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"

// Chat workspace connect: link a chat workspace in a
// popup so the half-written form underneath survives. Polling the connector list notices the new
// workspace; the host closes the popup (drops `active`) and hands the workspace on.

export const ChatConnectAttempt = Schema.Struct({
	attempt: Schema.Number,
	connector: ChatConnectorId,
	name: Schema.String,
	/** Workspaces that existed when the popup opened; anything else listed later is the new link. */
	knownIds: Schema.Array(Schema.String),
	phase: Schema.Literals(["popup", "grace"]),
	/** The install mutation is in flight (`flow.busy`). */
	isStarting: Schema.Boolean,
})
export type ChatConnectAttempt = typeof ChatConnectAttempt.Type

export const Model = Schema.Struct({ attempts: Schema.Number, active: Schema.NullOr(ChatConnectAttempt) })
export type Model = typeof Model.Type

export const init = (): Model => ({ attempts: 0, active: null })

export const Message = defineMessageUnion({
	SucceededStart: { attempt: Schema.Number },
	FailedStart: { attempt: Schema.Number, description: Schema.String },
	BlockedPopup: { attempt: Schema.Number },
	Polled: { attempt: Schema.Number },
	ClosedPopup: { attempt: Schema.Number },
	EndedGrace: { attempt: Schema.Number },
})
export type Message = typeof Message.Type

export type Toast = Readonly<{ title: string; description: string }>

/** What the host does next: re-read the connectors, and toast a failure. */
export type Step = Readonly<{ model: Model; isRefetching: boolean; toast: Option.Option<Toast> }>

const settled = (model: Model, isRefetching = false, toast: Option.Option<Toast> = Option.none()): Step => ({
	model,
	isRefetching,
	toast,
})

/** `connect(connector)`: a new attempt, remembering the workspaces already linked. */
export const start = (model: Model, connector: V2ChatConnector): Model => {
	const attempt = model.attempts + 1
	return {
		attempts: attempt,
		active: {
			attempt,
			connector: connector.id,
			name: connector.name,
			knownIds: connector.workspaces.map((workspace) => workspace.id),
			phase: "popup",
			isStarting: true,
		},
	}
}

/**
 * `waitingFor` (`flow.busy || flow.popupActive`): the connector being installed, its popup out or
 * in the close grace (Slack's consent page severs the opener, so the popup reads closed early).
 */
export const waitingFor = (model: Model): ChatConnectorId | null => model.active?.connector ?? null

const current = (model: Model, attempt: number): Option.Option<ChatConnectAttempt> =>
	Option.filter(Option.fromNullishOr(model.active), (active) => active.attempt === attempt)

const patch = (model: Model, attempt: ChatConnectAttempt, fields: Partial<ChatConnectAttempt>): Model => ({
	...model,
	active: { ...attempt, ...fields },
})

export const update = (model: Model, message: Message): Step =>
	Message.match<Step>(message, {
		SucceededStart: ({ attempt }) =>
			Option.match(current(model, attempt), {
				onNone: () => settled(model),
				// The install mutation's `reactivityKeys: ["chatIntegration"]` re-read the connectors.
				onSome: (active) => settled(patch(model, active, { isStarting: false }), true),
			}),
		FailedStart: ({ attempt, description }) =>
			Option.isNone(current(model, attempt))
				? settled(model)
				: settled({ ...model, active: null }, false, Option.some({ title: "Couldn't start the install", description })),
		BlockedPopup: ({ attempt }) =>
			Option.match(current(model, attempt), {
				onNone: () => settled(model),
				onSome: (active) =>
					settled(
						{ ...model, active: null },
						false,
						Option.some({
							title: `Your browser blocked the ${active.name} window`,
							description: "Allow pop-ups for this site, then try connecting again.",
						}),
					),
			}),
		// `onPoll` and `onClosed` both re-read the list; the answer is checked by `linkedOf`.
		Polled: ({ attempt }) => settled(model, Option.isSome(current(model, attempt))),
		ClosedPopup: ({ attempt }) =>
			Option.match(current(model, attempt), {
				onNone: () => settled(model),
				onSome: (active) => settled(patch(model, active, { phase: "grace", isStarting: false }), true),
			}),
		EndedGrace: ({ attempt }) =>
			Option.isNone(current(model, attempt)) ? settled(model) : settled({ ...model, active: null }),
	})

export type LinkedWorkspace = Readonly<{ connector: ChatConnectorId; id: ChatWorkspaceId; name: string }>

/** The connectors answered: a workspace the attempt did not know about is the new link. */
export const linkedOf = (model: Model, connectors: ReadonlyArray<V2ChatConnector>): Option.Option<LinkedWorkspace> =>
	Option.flatMap(Option.fromNullishOr(model.active), (active) =>
		Option.map(
			Option.fromNullishOr(
				connectors
					.find((entry) => entry.id === active.connector)
					?.workspaces.find((workspace) => !active.knownIds.includes(workspace.id)),
			),
			(workspace) => ({ connector: active.connector, id: workspace.id, name: workspace.name }),
		),
	)

/** The attempt ended on purpose (`closePopup`): dropping it releases, and so closes, the popup. */
export const finish = (model: Model): Model => ({ ...model, active: null })
