/**
 * The VCS sync queue's two ends in this Worker: the consumer, which hands its batch to the placed
 * fetch handler and applies the outcomes, and the fetch route that runs the batch.
 */
import type { Message } from "@cloudflare/workers-types"
import { Effect, Layer } from "effect"
import { HttpServerResponse } from "effect/http"
import type { VcsSyncIsolateCaches } from "@maple/backend/services/integrations/vcs/vcs-sync-isolate-caches"
import type { ApiPortsLayer } from "./bindings"
import { runEvent } from "./events"
import { vcsSyncModule } from "./modules"
import {
	applyOutcome,
	applyOutcomes,
	authorizeVcsSyncBatchRequest,
	dispatchVcsSyncBatch,
	type MessageOutcome,
	type PlacedMessage,
	toPlacedMessage,
	VCS_SYNC_MAX_RETRIES,
	vcsSyncTelemetry,
} from "./vcs-sync-dispatch"

/** What the consumer still owes the batch after the hop. */
export type HandOff =
	| { readonly run: "placed" }
	| { readonly run: "inline" }
	| { readonly run: "exhausted"; readonly messages: ReadonlyArray<Message<unknown>> }

const isFinalDelivery = (message: Message<unknown>) => message.attempts > VCS_SYNC_MAX_RETRIES

/**
 * Hands `messages` to the placed fetch handler and applies its outcomes. The whole batch runs
 * inline only when nothing ran there. A hop that failed after it may have started retries every
 * message, except those on their final delivery: those still get their terminal status recorded.
 */
export const handOffVcsSyncBatch = (
	env: Record<string, unknown>,
	messages: ReadonlyArray<Message<unknown>>,
) =>
	dispatchVcsSyncBatch(messages.map(toPlacedMessage), env).pipe(
		Effect.flatMap((outcomes) => applyOutcomes(messages, outcomes)),
		Effect.andThen(Effect.annotateCurrentSpan("maple.vcs.dispatch", "placed")),
		Effect.as<HandOff>({ run: "placed" }),
		Effect.catchTags({
			"@maple/api/errors/VcsSyncDispatchUnavailable": (error) =>
				Effect.annotateCurrentSpan({
					"maple.vcs.dispatch": "inline",
					"maple.vcs.dispatch.reason": error.reason,
				}).pipe(Effect.as<HandOff>({ run: "inline" })),
			"@maple/api/errors/VcsSyncDispatchError": (error) =>
				Effect.logError("Placed VCS sync batch failed; retrying its messages", error).pipe(
					Effect.andThen(Effect.annotateCurrentSpan("maple.vcs.dispatch", "failed")),
					Effect.andThen(
						Effect.forEach(
							messages.filter((message) => !isFinalDelivery(message)),
							(message) => applyOutcome(message, undefined),
							{ discard: true },
						),
					),
					Effect.as<HandOff>({ run: "exhausted", messages: messages.filter(isFinalDelivery) }),
				),
		}),
		Effect.withSpan("VcsSyncQueue.dispatch", {
			kind: "producer",
			attributes: { "messaging.batch.message_count": messages.length },
		}),
	)

/**
 * The placed end, reached only through the self binding. Answers 200 with every message's outcome;
 * a failure is a 500, which the consumer treats as unknown and retries.
 */
export const serveVcsSyncBatch = <E>(
	env: Record<string, unknown>,
	run: (
		messages: ReadonlyArray<PlacedMessage>,
		placement: string,
	) => Effect.Effect<ReadonlyArray<MessageOutcome>, E>,
) =>
	authorizeVcsSyncBatchRequest(env).pipe(
		Effect.flatMap(({ messages, placement }) =>
			run(messages, placement).pipe(
				Effect.map((outcomes) => HttpServerResponse.jsonUnsafe({ outcomes })),
				Effect.catchCause((cause) =>
					Effect.logError("Placed VCS sync batch failed", cause).pipe(
						Effect.as(HttpServerResponse.empty({ status: 500 })),
					),
				),
			),
		),
		Effect.catchTag("@maple/api/errors/VcsSyncBatchRefused", ({ status }) =>
			Effect.succeed(HttpServerResponse.empty({ status })),
		),
	)

const vcsSyncLayer = (ports: ApiPortsLayer, caches: VcsSyncIsolateCaches) =>
	Effect.map(vcsSyncModule, ({ VcsSyncLive }) =>
		VcsSyncLive.pipe(
			Layer.provide(caches),
			Layer.provideMerge(vcsSyncTelemetry),
			Layer.provideMerge(ports),
		),
	)

/** The queue consumer: placed when the handler takes the batch, else inline over its own graph. */
export const consumeVcsSyncBatch = (
	ports: ApiPortsLayer,
	env: Record<string, unknown>,
	caches: VcsSyncIsolateCaches,
	messages: ReadonlyArray<Message<unknown>>,
) =>
	handOffVcsSyncBatch(env, messages).pipe(
		// Released here, which flushes the dispatch span before an inline run builds its own graph.
		// oxlint-disable-next-line effecttsgo/strict-effect-provide -- the event IS the boundary the layer belongs to.
		Effect.provide(vcsSyncTelemetry.pipe(Layer.provideMerge(ports))),
		Effect.flatMap((handOff) =>
			handOff.run === "placed" || (handOff.run === "exhausted" && handOff.messages.length === 0)
				? Effect.void
				: Effect.flatMap(
						Effect.all([vcsSyncModule, vcsSyncLayer(ports, caches)]),
						([{ processBatch, recordExhaustedBatch }, layer]) =>
							runEvent(
								handOff.run === "inline"
									? processBatch({ messages })
									: recordExhaustedBatch(handOff.messages),
								layer,
							),
					),
		),
	)

/** The fetch route the self binding reaches: the batch over its own graph and Postgres socket. */
export const vcsSyncBatchRoute = (
	ports: ApiPortsLayer,
	env: Record<string, unknown>,
	caches: VcsSyncIsolateCaches,
) =>
	serveVcsSyncBatch(env, (messages, placement) =>
		Effect.flatMap(Effect.all([vcsSyncModule, vcsSyncLayer(ports, caches)]), ([{ processPlacedBatch }, layer]) =>
			runEvent(processPlacedBatch(messages, placement), layer),
		),
	)
