/**
 * The seam.
 *
 * Every normalized event a connector produces — over a socket or over a webhook — arrives here,
 * and this is the only thing the ingress half of this Worker knows about what happens next. It
 * records that the event arrived and hands it to the conversation's relay object, which owns
 * everything that follows; see `relay/ConnectorRelay.ts` for why that is a second object and not
 * this fiber.
 *
 * What is recorded is deliberately thin: the kind of event, which connector, and which workspace.
 * **Never the message text.** It is a customer's conversation, it is not needed to tell whether
 * ingress is working, and a log line is the easiest place in the system to leak one.
 */
import type { InboundEvent, InboundMessage } from "@maple/chat-platform"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { Context, Effect, Layer } from "effect"
import { connectorRelayStub, type ConnectorRelayStub } from "./relay/stub.ts"

export interface InboundHandlerApi {
	readonly handle: (event: InboundEvent) => Effect.Effect<void>
}

/** How the handler reaches a conversation's relay. The Worker env in production; a fake in tests. */
export interface InboundRelay {
	readonly forEvent: (event: InboundEvent) => ConnectorRelayStub | undefined
}

export class InboundHandler extends Context.Service<InboundHandler, InboundHandlerApi>()(
	"@maple/chat-bot/InboundHandler",
) {
	/** The handler this Worker runs: over the relay objects its own env binds. */
	static readonly layer = (env: Record<string, unknown>): Layer.Layer<InboundHandler> =>
		Layer.succeed(
			InboundHandler,
			InboundHandler.of(inboundHandler({ forEvent: (event) => connectorRelayStub(env, event) })),
		)
}

/**
 * Whether a message is worth a hop to the conversation's relay.
 *
 * A connector reports what it can see, which on a busy platform is far more than the bot was
 * addressed in. Whether an unaddressed message is a TURN is the relay's decision and needs the
 * conversation's session to make (`relay/conversation.ts`); what is decided here is only what
 * cannot possibly be one — a message from another bot, and a message whose text the platform
 * withheld — because deciding those costs nothing and deciding them later costs a round trip per
 * message in every channel the bot can see.
 */
const worthRelaying = (message: InboundMessage): boolean =>
	message.mentionsBot || (!message.author.isBot && message.text.trim() !== "")

/**
 * The handler over one way of reaching the relay.
 */
export const inboundHandler = (relay: InboundRelay): InboundHandlerApi => ({
	handle: (event) => {
		const attributes = {
			"maple.chat.event": event.type,
			"maple.chat.connector": event.connector,
			"maple.chat.workspace_id": event.workspaceId,
		}
		return Effect.gen(function* () {
			yield* Effect.logInfo("Chat connector event").pipe(Effect.annotateLogs(attributes))
			if (event.type === "message" && !worthRelaying(event)) return
			const stub = relay.forEvent(event)
			if (stub === undefined) {
				return yield* Effect.logError("No relay binding on this deployment").pipe(
					Effect.annotateLogs(attributes),
				)
			}
			yield* Effect.tryPromise(() => stub.deliver(event)).pipe(
				// The cause is summarized, never rendered: everything this Worker fails on carries the
				// conversation somewhere inside it.
				Effect.catchCause((cause) =>
					Effect.logError("Chat connector event could not be delivered").pipe(
						Effect.annotateLogs({ ...attributes, "error.type": summarizeCause(cause) }),
					),
				),
			)
		}).pipe(Effect.withSpan("chat_bot.inbound_event", { attributes }))
	},
})
