import type { Message } from "@cloudflare/workers-types"

/**
 * What a queue consumer receives: the delivery's messages, each with its own
 * `ack` / `retry`. The consumers decide per message; alchemy's event source acks
 * the batch after they return, which a message already retried ignores.
 */
export interface QueueBatch<Body = unknown> {
	readonly messages: ReadonlyArray<Message<Body>>
}
