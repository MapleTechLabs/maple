import { getTracesFacetValues } from "@maple/web-data/warehouse/traces"
import { Effect, Schema, Array as Arr } from "effect"
import { Command } from "foldkit"
import { ReadCache } from "../../data/read-cache"
import { requestKey } from "@maple/views/data/request-key"
import { Message } from "./model"

/** `getTracesFacetValuesResultAtom`'s `staleTime`, counted from the palette closing (its unmount). */
const SERVICES_IDLE_TTL_MS = 30_000
const SERVICES_OPERATION = "getTracesFacetValues"
const SERVICES_INPUT = { data: { facet: "service" as const } }

const FacetValues = Schema.Struct({
	data: Schema.Array(Schema.Struct({ name: Schema.String, count: Schema.Number })),
})

/** The palette's service names, through the read cache under the open org. */
export const LoadPaletteServices = Command.define("LoadPaletteServices", {
	messages: [Message.SucceededLoadServices, Message.FailedLoadServices],
	execute: Effect.gen(function* () {
		const cache = yield* ReadCache
		const response = yield* cache.readInOrg(
			{
				operation: SERVICES_OPERATION,
				input: SERVICES_INPUT,
				idleTtlMs: SERVICES_IDLE_TTL_MS,
				schema: FacetValues,
			},
			getTracesFacetValues(SERVICES_INPUT),
		)
		return Message.SucceededLoadServices({ serviceNames: Arr.map(response.data, (item) => item.name) })
	}).pipe(Effect.orElseSucceed(() => Message.FailedLoadServices())),
})

/** The palette unmounted: the services read's idle TTL starts now. */
export const ReleasePaletteServices = Command.define("ReleasePaletteServices", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedReleaseServices],
	execute: ({ orgId }) =>
		Effect.flatMap(ReadCache, (cache) =>
			cache.release([requestKey(orgId, SERVICES_OPERATION, SERVICES_INPUT)]),
		).pipe(Effect.as(Message.CompletedReleaseServices())),
})

/** Base UI keeps the highlighted item in view as the arrows move it (`scrollIntoView` nearest). */
export const ScrollHighlighted = Command.define("ScrollHighlighted", {
	args: { itemId: Schema.String },
	messages: [Message.CompletedScrollHighlighted],
	execute: ({ itemId }) =>
		Effect.sync(() => {
			document.getElementById(itemId)?.scrollIntoView({ block: "nearest" })
			return Message.CompletedScrollHighlighted()
		}),
})

const nextFrame = Effect.callback<void>((resume) => {
	requestAnimationFrame(() => resume(Effect.void))
})

/**
 * An action that opens another overlay keeps the palette a few frames, so focus moves on from its
 * input (keeping `:focus-visible`).
 */
export const DelayClose = Command.define("DelayClose", {
	messages: [Message.ElapsedCloseDelay],
	execute: nextFrame.pipe(
		Effect.andThen(nextFrame),
		Effect.andThen(nextFrame),
		Effect.as(Message.ElapsedCloseDelay()),
	),
})
