import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import type { CallableTaggedStruct } from "foldkit/schema"

// The page timings every page shares, and the Commands built on them, so a page names its
// Command and its result Message and nothing else.

/** `PageRefreshProvider`: how long Reload shows its pending spinner. */
export const RELOAD_SPIN = Duration.millis(600)

/** `ToolbarSearch`'s debounce: a keystroke settles into a search after this long. */
export const SEARCH_DEBOUNCE = Duration.millis(300)

/** Ends the Reload spin: sends `completed` with the reload `version` after `RELOAD_SPIN`. */
export const reloadSpin = <const Name extends string, const Tag extends string>(
	name: Name,
	completed: CallableTaggedStruct<Tag, { readonly version: Schema.Number }>,
) =>
	Command.define(name, {
		args: { version: Schema.Number },
		messages: [completed],
		execute: ({ version }) => Effect.as(Effect.sleep(RELOAD_SPIN), completed({ version })),
	})

/** Reads the clock: sends `completed` with the current time in epoch ms. */
export const readClock = <const Name extends string, const Tag extends string>(
	name: Name,
	completed: CallableTaggedStruct<Tag, { readonly nowMs: Schema.Number }>,
) =>
	Command.define(name, {
		messages: [completed],
		execute: Effect.map(Clock.currentTimeMillis, (nowMs) => completed({ nowMs })),
	})
