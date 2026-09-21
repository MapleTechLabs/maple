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
import type { InboundEvent } from "@maple/chat-platform"
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
) {}

/**
 * The handler over one way of reaching the relay.
 *
 * A message that addressed nobody is dropped here rather than in the relay: a connector reports
 * what it can see in a conversation the bot is in, and only the mentions are a turn.
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
			if (event.type === "message" && !event.mentionsBot) return
			const stub = relay.forEvent(event)
			if (stub === undefined) {
				return yield* Effect.logError("No relay binding on this deployment").pipe(
					Effect.annotateLogs(attributes),
				)
			}
			yield* Effect.tryPromise(() => stub.deliver(event)).pipe(
				Effect.catchCause((cause) =>
					Effect.logError("Chat connector event could not be delivered", cause).pipe(
						Effect.annotateLogs(attributes),
					),
				),
			)
		}).pipe(Effect.withSpan("chat_bot.inbound_event", { attributes }))
	},
})

/** The handler this Worker runs: the relay objects its own env binds. */
export const inboundHandlerLayer = (env: Record<string, unknown>): Layer.Layer<InboundHandler> =>
	Layer.succeed(InboundHandler, inboundHandler({ forEvent: (event) => connectorRelayStub(env, event) }))
