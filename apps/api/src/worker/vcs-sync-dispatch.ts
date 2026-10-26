/**
 * Cloudflare places only fetch handlers, so a VCS sync batch runs wherever the queue delivers it,
 * far from the database and the ingest gateway. The consumer hands the batch to this Worker's own
 * fetch handler over a self service binding instead, and that invocation is placed. The handler
 * answers one outcome per message, which the consumer applies to the messages it holds.
 */
import { selfFetcher, workerSecretFor } from "@maple/backend/platform/self-binding"
import { isValidInternalBearer } from "@maple/backend/services/auth/internal-auth"
import type { Message } from "@cloudflare/workers-types"
// The subpath, not the barrel: this module loads with the Worker.
import { VcsSyncJob } from "@maple/domain/http/vcs"
import { eventTelemetry } from "@maple/infra/worker-telemetry"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { Effect, Option, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpIncomingMessage, HttpServerRequest } from "effect/http"

/**
 * Deliberately not `maple-api`: background work sharing the request-facing
 * service's name skewed its percentiles (p99 32s, 2026-09-04).
 */
export const vcsSyncTelemetry = eventTelemetry({ serviceName: "maple-vcs-sync" })

/** The service binding to this Worker itself, declared in the Worker's props. */
export const SELF_BINDING = "API_SELF"
/**
 * The bearer the hop carries: a random secret bound only to this Worker, so no other holder of
 * an internal credential can post jobs to the route.
 */
export const VCS_SYNC_HOP_SECRET = "VCS_SYNC_HOP_SECRET"
export const VCS_SYNC_BATCH_PATH = "/internal/vcs-sync/batch"
// The binding routes by name; the origin is the formality `Request` insists on.
const VCS_SYNC_BATCH_URL = `https://maple-api.internal${VCS_SYNC_BATCH_PATH}`

/** The consumer's `batchSize` and `maxRetries`; a delivery past `maxRetries` is the last one. */
export const VCS_SYNC_BATCH_SIZE = 10
export const VCS_SYNC_MAX_RETRIES = 3
/** A full batch of messages at the queue's 128 KB message limit, plus the envelope. */
export const VCS_SYNC_BATCH_MAX_BYTES = VCS_SYNC_BATCH_SIZE * 128 * 1024 + 16 * 1024

/** A queue message as it crosses the hop: the parts processing reads. */
export const PlacedMessage = Schema.Struct({
	id: Schema.String,
	body: Schema.Unknown,
	attempts: Schema.Number,
})
export type PlacedMessage = typeof PlacedMessage.Type

/** What the route accepts: at most one queue batch of real jobs. */
export const VcsSyncBatchRequest = Schema.Struct({
	messages: Schema.Array(
		Schema.Struct({ id: Schema.String, body: VcsSyncJob, attempts: Schema.Number }),
	).check(Schema.isMaxLength(VCS_SYNC_BATCH_SIZE)),
})
const decodeBatchRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(VcsSyncBatchRequest))

/** What to do with one message: done (or recorded as exhausted), or deliver it again. */
export const MessageOutcome = Schema.Union([
	Schema.Struct({ id: Schema.String, outcome: Schema.Literal("ack") }),
	Schema.Struct({
		id: Schema.String,
		outcome: Schema.Literal("retry"),
		delaySeconds: Schema.optionalKey(Schema.Number),
	}),
])
export type MessageOutcome = typeof MessageOutcome.Type

export const VcsSyncBatchResponse = Schema.Struct({ outcomes: Schema.Array(MessageOutcome) })

/** The hop failed after the batch may have started: its outcomes are unknown. */
export class VcsSyncDispatchError extends Schema.TaggedError<VcsSyncDispatchError>()(
	"@maple/api/errors/VcsSyncDispatchError",
	{
		message: Schema.String,
		status: Schema.optionalKey(Schema.Number),
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

/** The batch did not run in the placed handler, so the consumer runs it inline. */
export class VcsSyncDispatchUnavailable extends Schema.TaggedError<VcsSyncDispatchUnavailable>()(
	"@maple/api/errors/VcsSyncDispatchUnavailable",
	{
		message: Schema.String,
		reason: Schema.Literals(["no-binding", "no-token", "refused-400", "refused-401", "refused-404"]),
	},
) {}

/** A request to the batch route that the handler refuses before running anything. */
export class VcsSyncBatchRefused extends Schema.TaggedError<VcsSyncBatchRefused>()(
	"@maple/api/errors/VcsSyncBatchRefused",
	{
		message: Schema.String,
		status: Schema.Literals([400, 401, 404]),
	},
) {}

const decodeResponse = HttpIncomingMessage.schemaBodyJson(VcsSyncBatchResponse)

/**
 * Runs `messages` in the placed fetch handler and returns their outcomes. Fails with
 * `VcsSyncDispatchUnavailable` when nothing ran there, so the caller runs the batch inline.
 */
export const dispatchVcsSyncBatch = Effect.fnUntraced(function* (
	messages: ReadonlyArray<PlacedMessage>,
	env: Record<string, unknown>,
) {
	const binding = selfFetcher(env, SELF_BINDING)
	const token = yield* workerSecretFor(env, VCS_SYNC_HOP_SECRET)
	if (Option.isNone(binding)) {
		return yield* new VcsSyncDispatchUnavailable({
			message: "No self service binding",
			reason: "no-binding",
		})
	}
	if (Option.isNone(token)) {
		return yield* new VcsSyncDispatchUnavailable({
			message: "No hop secret",
			reason: "no-token",
		})
	}
	const client = Cloudflare.toHttpClient(Cloudflare.fromCloudflareFetcher(binding.value))
	const request = HttpClientRequest.post(VCS_SYNC_BATCH_URL).pipe(
		HttpClientRequest.bearerToken(token.value),
		HttpClientRequest.bodyJsonUnsafe({ messages }),
	)
	const response = yield* HttpClient.execute(request).pipe(
		Effect.provideService(HttpClient.HttpClient, client),
		Effect.mapError(
			(cause) => new VcsSyncDispatchError({ message: "Placed batch request failed", cause }),
		),
	)
	// Refused before running anything: a secret mismatch, a bad body, or a version without the route.
	if (response.status === 400 || response.status === 401 || response.status === 404) {
		return yield* new VcsSyncDispatchUnavailable({
			message: `Placed batch refused with ${response.status}`,
			reason: `refused-${response.status}`,
		})
	}
	if (response.status !== 200) {
		return yield* new VcsSyncDispatchError({
			message: `Placed batch answered ${response.status}`,
			status: response.status,
		})
	}
	const decoded = yield* decodeResponse(response).pipe(
		Effect.mapError(
			(cause) => new VcsSyncDispatchError({ message: "Unreadable placed batch outcome", cause }),
		),
	)
	return decoded.outcomes
})

/** A message with no outcome is delivered again: an unknown outcome is never acked. */
export const applyOutcome = (message: Message<unknown>, outcome: MessageOutcome | undefined) =>
	Effect.sync(() => {
		if (outcome?.outcome === "ack") return message.ack()
		if (outcome?.delaySeconds !== undefined) return message.retry({ delaySeconds: outcome.delaySeconds })
		return message.retry()
	})

export const applyOutcomes = (
	messages: ReadonlyArray<Message<unknown>>,
	outcomes: ReadonlyArray<MessageOutcome>,
) => {
	const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]))
	return Effect.forEach(messages, (message) => applyOutcome(message, byId.get(message.id)), {
		discard: true,
	})
}

export const toPlacedMessage = (message: Message<unknown>): PlacedMessage => ({
	id: message.id,
	body: message.body,
	attempts: message.attempts,
})

const refused = (status: 400 | 401 | 404, message: string) => new VcsSyncBatchRefused({ message, status })

/** The body as text, refused once it passes `VCS_SYNC_BATCH_MAX_BYTES`, before it is all buffered. */
const readBoundedBody = (request: HttpServerRequest.HttpServerRequest) =>
	Stream.runFoldEffect(
		request.stream.pipe(Stream.mapError(() => refused(400, "Unreadable batch"))),
		() => ({ bytes: 0, chunks: Array.of<Uint8Array>() }),
		(read, chunk) =>
			read.bytes + chunk.byteLength > VCS_SYNC_BATCH_MAX_BYTES
				? Effect.fail(refused(400, "Batch too large"))
				: Effect.succeed({ bytes: read.bytes + chunk.byteLength, chunks: [...read.chunks, chunk] }),
	).pipe(
		Effect.map(({ bytes, chunks }) => {
			const joined = new Uint8Array(bytes)
			chunks.reduce((offset, chunk) => (joined.set(chunk, offset), offset + chunk.byteLength), 0)
			return new TextDecoder().decode(joined)
		}),
	)

/**
 * Validates a request to the batch route and decodes its messages. The route serves only the self
 * binding: the bearer is a secret no other Worker holds, and a request from the internet, which
 * Cloudflare stamps with `cf-connecting-ip`, is refused before the bearer is checked.
 */
export const authorizeVcsSyncBatchRequest = Effect.fnUntraced(function* (env: Record<string, unknown>) {
	const request = yield* HttpServerRequest.HttpServerRequest
	// A 404, as if the route were absent; a binding call refused this way still runs inline.
	if (request.headers["cf-connecting-ip"] !== undefined) {
		return yield* refused(404, "Not found")
	}
	const authorized = Option.match(yield* workerSecretFor(env, VCS_SYNC_HOP_SECRET), {
		onNone: () => false,
		onSome: (expected) => isValidInternalBearer(request.headers["authorization"], expected),
	})
	if (!authorized) {
		return yield* refused(401, "Missing or invalid hop secret")
	}
	if (Number(request.headers["content-length"] ?? 0) > VCS_SYNC_BATCH_MAX_BYTES) {
		return yield* refused(400, "Batch too large")
	}
	const body = yield* readBoundedBody(request).pipe(
		Effect.flatMap(decodeBatchRequest),
		Effect.mapError((error) =>
			error._tag === "@maple/api/errors/VcsSyncBatchRefused" ? error : refused(400, "Unreadable batch"),
		),
	)
	return {
		messages: body.messages,
		placement: request.headers["cf-placement"] ?? "none",
	}
})
