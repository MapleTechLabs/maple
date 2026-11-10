// String operations effect/String lacks: function replacers, position-aware reads, HTML escaping
// and truncation. The wrappers each own the one native call they need.
import { Array as Arr, String as Str } from "effect"
import { dual } from "effect/Function"

/** Receives the full match and each capture group; an unmatched optional group is `undefined`. */
export type Replacer = (match: string, ...captures: Array<string | undefined>) => string

// A native replacer gets `p1..pn, offset, input` and, with named groups, a trailing groups object.
const capturesOf = (args: ReadonlyArray<unknown>): Array<string | undefined> => {
	const trailing = typeof args[args.length - 1] === "object" ? 3 : 2
	return Arr.map(args.slice(0, args.length - trailing), (arg) =>
		typeof arg === "string" ? arg : undefined,
	)
}

/**
 * `String.prototype.replace` with a function replacer. A global regex replaces every match.
 *
 * @example
 * pipe("a_b", replaceWith(/_([a-z])/g, (_, c = "") => c.toUpperCase())) // "aB"
 */
export const replaceWith: {
	(pattern: string | RegExp, replacer: Replacer): (self: string) => string
	(self: string, pattern: string | RegExp, replacer: Replacer): string
} = dual(3, (self: string, pattern: string | RegExp, replacer: Replacer): string =>
	// @effect-diagnostics-next-line preferEffectString:off -- the native call this helper wraps
	self.replace(pattern, (match: string, ...rest: Array<unknown>) => replacer(match, ...capturesOf(rest))),
)

/** First index of `search` at or after `from`, or -1. */
export const indexOfFrom: {
	(search: string, from: number): (self: string) => number
	(self: string, search: string, from: number): number
} = dual(3, (self: string, search: string, from: number): number =>
	// @effect-diagnostics-next-line preferEffectString:off -- the native call this helper wraps
	self.indexOf(search, from),
)

/** UTF-16 code unit at `index`, NaN when out of range. No Option, for per-character hash loops. */
export const codeUnitAt: {
	(index: number): (self: string) => number
	(self: string, index: number): number
} = dual(2, (self: string, index: number): number =>
	// @effect-diagnostics-next-line preferEffectString:off -- the native call this helper wraps
	self.charCodeAt(index),
)

/** Code point at `index`, 0 when out of range. No Option, for per-character hash loops. */
export const codePointAt: {
	(index: number): (self: string) => number
	(self: string, index: number): number
} = dual(
	2,
	(self: string, index: number): number =>
		// @effect-diagnostics-next-line preferEffectString:off -- the native call this helper wraps
		self.codePointAt(index) ?? 0,
)

/** Every match of a global regex, each with its numeric `index`. */
export const matchAllIndexed: {
	(pattern: RegExp): (self: string) => Array<RegExpExecArray>
	(self: string, pattern: RegExp): Array<RegExpExecArray>
} = dual(2, (self: string, pattern: RegExp): Array<RegExpExecArray> =>
	// @effect-diagnostics-next-line preferEffectString:off -- the native call this helper wraps
	Arr.fromIterable(self.matchAll(pattern)),
)

/** Escapes text for HTML element content and quoted attributes alike. */
export const escapeHtml = (value: string): string =>
	Str.replaceAll(
		"'",
		"&#39;",
	)(
		Str.replaceAll(
			'"',
			"&quot;",
		)(Str.replaceAll(">", "&gt;")(Str.replaceAll("<", "&lt;")(Str.replaceAll("&", "&amp;")(value)))),
	)

/** `text` cut to at most `max` characters, the last one an ellipsis when anything was cut. */
export const truncate = (text: string, max: number): string =>
	text.length <= max ? text : `${Str.slice(0, max - 1)(text)}…`
