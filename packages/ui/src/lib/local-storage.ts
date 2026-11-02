import { Effect, Option, Schema } from "effect"
import { trySync } from "./try-sync"

/**
 * `localStorage` behind `Option`.
 *
 * Every access throws outright — not returns null — in private mode, in a
 * sandboxed iframe, and wherever a browser has site data blocked, so both the
 * read and the write need the same guard. Preferences stored here are always a
 * nicety; a caller that cannot read one falls back to its default.
 */
export const readLocalStorage = (key: string): Option.Option<string> =>
	Option.flatMapNullishOr(
		trySync(() => localStorage.getItem(key)),
		(value) => value,
	)

class LocalStorageWriteError extends Schema.TaggedError<LocalStorageWriteError>()(
	"@maple/ui/lib/LocalStorageWriteError",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

/** Best-effort write. A quota or availability failure is silently dropped. */
export const writeLocalStorage = (key: string, value: string): void => {
	Effect.runSync(
		Effect.ignore(
			Effect.try({
				try: () => localStorage.setItem(key, value),
				catch: (cause) =>
					new LocalStorageWriteError({ message: `localStorage write failed for ${key}`, cause }),
			}),
		),
	)
}
