import { tokenFallback } from "@maple/ui/lib/colors"
import { Effect, Queue, Schema, Stream } from "effect"
import { Mount } from "foldkit"
import { defineMessageUnion } from "foldkit/message"

/**
 * Design tokens resolved to literal colours, keyed by custom property name (`--chart-1`).
 * Canvas cannot read `var()`, so charts take literals; reading them is DOM work, done by a Mount.
 */
export const ThemeColors = Schema.Record(Schema.String, Schema.String)
export type ThemeColors = typeof ThemeColors.Type

export const ThemeMessage = defineMessageUnion({
	ResolvedThemeColors: { colors: ThemeColors },
})
export type ThemeMessage = typeof ThemeMessage.Type

/** The custom property a token names, or `undefined` for a literal colour (`resolvePlotColor`'s unwrap). */
export const tokenProperty = (token: string): string | undefined => {
	const inner = token.startsWith("var(") && token.endsWith(")") ? token.slice(4, -1).trim() : token
	const name = inner.includes(",") ? token : inner
	return name.startsWith("--") ? name : undefined
}

/** `resolvePlotColor` (packages/ui/src/components/plot/theme.ts) against a resolved snapshot. */
export const resolveColor = (
	colors: ThemeColors,
	token: string,
	fallback: string = tokenFallback(token),
): string => {
	const property = tokenProperty(token)
	if (property === undefined) return token
	const value = colors[property]
	return value === undefined || value === "" ? fallback : value
}

const readTokens = (element: Element, tokens: ReadonlyArray<string>): ThemeColors => {
	const style = getComputedStyle(element)
	return Object.fromEntries(
		tokens.flatMap((token) => {
			const property = tokenProperty(token)
			return property === undefined ? [] : [[property, style.getPropertyValue(property).trim()]]
		}),
	)
}

/**
 * Reads `tokens` off the element (custom properties inherit from `<html>`) now and again on every
 * light/dark flip of the `<html>` class, like `usePlotColors` re-resolving on `useTheme`.
 */
export const ResolveThemeColors = Mount.defineStream("ResolveThemeColors", {
	args: { tokens: Schema.Array(Schema.String) },
	messages: [ThemeMessage.ResolvedThemeColors],
	handler: function* () {
		return ({ element, tokens }) =>
			Stream.callback<ThemeMessage>((queue) =>
				Effect.acquireRelease(
					Effect.sync(() => {
						const emit = () =>
							Queue.offerUnsafe(
								queue,
								ThemeMessage.ResolvedThemeColors({ colors: readTokens(element, tokens) }),
							)
						emit()
						const observer = new MutationObserver(emit)
						observer.observe(document.documentElement, {
							attributes: true,
							attributeFilter: ["class"],
						})
						return observer
					}),
					(observer) => Effect.sync(() => observer.disconnect()),
				).pipe(Effect.flatMap(() => Effect.never)),
			)
	},
})
