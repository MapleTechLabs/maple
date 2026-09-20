/**
 * The seam.
 *
 * Every normalized event a connector produces — over a socket or over a webhook
 * — arrives here, and this is the only thing the rest of this Worker knows about
 * what happens next. V1 records that the event arrived and returns; the PR that
 * wires chat platforms to the agent replaces this implementation and nothing
 * else in the app changes.
 *
 * What is recorded is deliberately thin: the kind of event, which connector, and
 * which workspace. **Never the message text.** It is a customer's conversation,
 * it is not needed to tell whether ingress is working, and a log line is the
 * easiest place in the system to leak one.
 */
import type { InboundEvent } from "@maple/chat-platform"
import { Context, Effect, Layer } from "effect"

export interface InboundHandlerApi {
	readonly handle: (event: InboundEvent) => Effect.Effect<void>
}

export class InboundHandler extends Context.Service<InboundHandler, InboundHandlerApi>()(
	"@maple/chat-bot/InboundHandler",
	{
		// Annotated with the api rather than built through the class's own `of`:
		// `make` is declared inside the class declaration, so naming the class
		// here would be a circular reference.
		make: Effect.succeed<InboundHandlerApi>({
			handle: (event) => {
				const attributes = {
					"maple.chat.event": event.type,
					"maple.chat.connector": event.connector,
					"maple.chat.workspace_id": event.workspaceId,
				}
				return Effect.logInfo("Chat connector event").pipe(
					Effect.annotateLogs(attributes),
					Effect.withSpan("chat_bot.inbound_event", { attributes }),
				)
			},
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
