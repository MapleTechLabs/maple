import { resolve } from "node:path"
import { Effect, Schema } from "effect"
import { ensureLocalToken, localTokenMatches } from "../local-token"

export class EventConsumerTokenError extends Schema.TaggedError<EventConsumerTokenError>()(
	"@maple/cli/eventing/EventConsumerTokenFailed",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

export const eventConsumerTokenPath = (dataDir: string): string => `${resolve(dataDir)}.event-consumer-token`
export const ensureEventConsumerToken = (dataDir: string): Effect.Effect<string, EventConsumerTokenError> =>
	Effect.tryPromise({
		try: () => ensureLocalToken(eventConsumerTokenPath(dataDir), "event consumer token"),
		catch: (cause) =>
			new EventConsumerTokenError({
				message: cause instanceof Error ? cause.message : String(cause),
				cause,
			}),
	})
export const eventConsumerTokenMatches = localTokenMatches
