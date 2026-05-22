import { WorkerEnvironment } from "@maple/effect-cloudflare/worker-environment"
import { Context, Effect, Layer, Schema } from "effect"

type QueueBindingShape = {
	send: (body: unknown, options?: { delaySeconds?: number }) => Promise<void>
	sendBatch: (messages: Array<{ body: unknown; delaySeconds?: number }>) => Promise<void>
}

const isQueueBinding = (value: unknown): value is QueueBindingShape => {
	if (!value || typeof value !== "object") return false
	const obj = value as { send?: unknown; sendBatch?: unknown }
	return typeof obj.send === "function" && typeof obj.sendBatch === "function"
}

export class GithubQueueUnboundError extends Schema.TaggedErrorClass<GithubQueueUnboundError>()(
	"GithubSyncQueueQueueUnboundError",
	{ bindingName: Schema.String },
) {}

const QUEUE_BINDING_NAME = "GITHUB_SYNC_QUEUE"

export class GithubSyncQueueBinding extends Context.Service<GithubSyncQueueBinding, QueueBindingShape>()(
	"GitHubSyncQueueBinding",
	{
		make: Effect.gen(function* () {
			const env = yield* WorkerEnvironment
			const binding = env[QUEUE_BINDING_NAME]
			if (!isQueueBinding(binding)) {
				return yield* Effect.fail(new GithubQueueUnboundError({ bindingName: QUEUE_BINDING_NAME }))
			}

			return binding
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)

	// Dev/test alternative - wire this in environments where the queue is absent
	// but you don't want the worker to refuse to start/fail on runtime building.
	static readonly layerNoop = Layer.succeed(this, {
		send: async () => {},
		sendBatch: async () => {},
	} satisfies QueueBindingShape)
}
