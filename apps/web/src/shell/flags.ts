import { readLocalStorage } from "@maple/ui/lib/local-storage"
import { Effect, Option, Schema } from "effect"
import { readQuotaApproachingDismissed } from "./billing-banners"
import { readDashboardFavorites } from "./favorites"
import { INFRA_SURFACES_STORAGE_PREFIX, NAMESPACE_STORAGE_PREFIX, THEME_STORAGE_KEY } from "./command"
import { Theme } from "./message"
import type { ShellFlags } from "./model"
import { NavSurface } from "./nav"
import { FILTER_COLLAPSED_QUERY, MOBILE_QUERY, SMALL_QUERY } from "./subscription"
import { detectPlatform } from "./palette/shortcuts"

const decodeTheme = Schema.decodeUnknownOption(Theme)

/** The `<html>` class the pre-paint script set, else storage, else dark (`use-theme`'s order). */
const readTheme = (): Theme => {
	const root = document.documentElement
	if (root.classList.contains("light")) return "light"
	if (root.classList.contains("dark")) return "dark"
	return Option.getOrElse(
		Option.flatMap(readLocalStorage(THEME_STORAGE_KEY), decodeTheme),
		() => "dark" as const,
	)
}

/** Every org's pinned namespace, so the shell knows the active org's before the session resolves. */
const readPinnedNamespaces: Effect.Effect<Record<string, string>> = Effect.try(() =>
	Object.fromEntries(
		Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
			.filter((key): key is string => key !== null && key.startsWith(NAMESPACE_STORAGE_PREFIX))
			.map(
				(key) =>
					[key.slice(NAMESPACE_STORAGE_PREFIX.length), localStorage.getItem(key) ?? ""] as const,
			)
			.filter(([, value]) => value.length > 0),
	),
).pipe(Effect.orElseSucceed(() => ({})))

const decodeSurfaces = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(NavSurface)))

/** Every org's remembered infra surfaces; an entry that no longer decodes is skipped. */
const readRememberedSurfaces: Effect.Effect<Record<string, ReadonlyArray<NavSurface>>> = Effect.try(() =>
	Object.fromEntries(
		Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
			.filter((key): key is string => key !== null && key.startsWith(INFRA_SURFACES_STORAGE_PREFIX))
			.flatMap((key) =>
				Option.match(decodeSurfaces(localStorage.getItem(key)), {
					onNone: () => [],
					onSome: (surfaces) => [
						[key.slice(INFRA_SURFACES_STORAGE_PREFIX.length), surfaces] as const,
					],
				}),
			),
	),
).pipe(Effect.orElseSucceed(() => ({})))

/** Persisted shell UI state, read once before the first render. */
export const readShellFlags: Effect.Effect<ShellFlags> = Effect.gen(function* () {
	const pinnedNamespaces = yield* readPinnedNamespaces
	return {
		isMobile: window.matchMedia(MOBILE_QUERY).matches,
		isFilterCollapsed: window.matchMedia(FILTER_COLLAPSED_QUERY).matches,
		isBelowSm: window.matchMedia(SMALL_QUERY).matches,
		theme: readTheme(),
		pinnedNamespaces,
		dashboardFavorites: readDashboardFavorites(),
		rememberedSurfaces: yield* readRememberedSurfaces,
		isQuotaApproachingDismissed: yield* readQuotaApproachingDismissed,
		platform: detectPlatform(),
	}
})
