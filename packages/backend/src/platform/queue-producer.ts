import type * as Cloudflare from "@alchemy.run/cloudflare"
import { Effect } from "effect"
import { dischargeRuntimeContext } from "@maple/infra/worker-runtime"
import { type QueueProducer, QueueSendError } from "./bindings"

/**
 * A producer over the raw queue handle rather than alchemy's `send`: the
 * client's option type omits `delaySeconds`, which the VCS producer needs to
 * park a rate-limited continuation until the provider's budget is back.
 */
export const queueProducer = (client: Cloudflare.Queues.WriteQueueClient): QueueProducer => ({
	sendBatch: (messages) =>
		dischargeRuntimeContext(client.raw).pipe(
			Effect.flatMap((queue) =>
				Effect.tryPromise({
					try: () => queue.sendBatch(messages),
					catch: (cause) =>
						new QueueSendError({
							message: cause instanceof Error ? cause.message : "queue sendBatch failed",
							cause,
						}),
				}),
			),
		),
})
