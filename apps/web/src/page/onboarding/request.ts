import { DateTime, Effect, Option, Predicate } from "effect"

/**
 * An endpoint error's own `message` (the JSON body
 * the API sent), otherwise the screen's fallback copy.
 */
export const endpointMessage = (error: unknown, fallback: string): string =>
	Predicate.hasProperty(error, "_tag") &&
	typeof error._tag === "string" &&
	error._tag.startsWith("@maple/http/errors/") &&
	Predicate.hasProperty(error, "message") &&
	typeof error.message === "string" &&
	error.message.length > 0
		? error.message
		: fallback

/** `new Date(iso).toLocaleTimeString()`, read in a Command: the browser's locale and zone. */
export const localeTimeOf = (iso: string): Effect.Effect<string> =>
	Effect.sync(() =>
		Option.match(DateTime.make(iso), {
			onNone: () => "Invalid Date",
			onSome: (dateTime) => new Date(DateTime.toEpochMillis(dateTime)).toLocaleTimeString(),
		}),
	)
