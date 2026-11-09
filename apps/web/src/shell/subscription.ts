import { isDialogOpen, isEditableTarget, pressedKey } from "@maple/ui/lib/keyboard"
import { Clock, Duration, Effect, Option, Stream, String as Str } from "effect"
import { AsyncData } from "foldkit"
import { Dom } from "foldkit"
import { DASHBOARD_FAVORITES_EVENT, readDashboardFavorites } from "./favorites"
import { Message } from "./message"
import type { Model } from "./model"
import { nextHandoffMs } from "./oncall"

/** `useIsMobile` (`max-md`): below 768px the sidebar is a sheet. */
export const MOBILE_QUERY = "(max-width: 767px)"

export const viewportChanges: Stream.Stream<Message> = Dom.streamFromMediaQuery({
	query: MOBILE_QUERY,
	mapMatches: (isMobile) => Message.ChangedViewport({ isMobile }),
})

/** `PageLayout`'s `useMediaQuery("max-lg")`: below 1024px the page rails are sheets. */
export const FILTER_COLLAPSED_QUERY = "(max-width: 1023px)"

export const filterViewportChanges: Stream.Stream<Message> = Dom.streamFromMediaQuery({
	query: FILTER_COLLAPSED_QUERY,
	mapMatches: (isCollapsed) => Message.ChangedFilterViewport({ isCollapsed }),
})

/** `useMediaQuery("max-sm")`, which a few page layouts branch on (the analytics chart's margin). */
export const SMALL_QUERY = "(max-width: 639px)"

export const smallViewportChanges: Stream.Stream<Message> = Dom.streamFromMediaQuery({
	query: SMALL_QUERY,
	mapMatches: (isBelowSm) => Message.ChangedSmallViewport({ isBelowSm }),
})

/** `SidebarProvider`'s ⌘B / Ctrl+B toggle. */
export const sidebarShortcut: Stream.Stream<Message> = Dom.streamFromEventFilterMap({
	target: () => window,
	type: "keydown",
	filterMapEvent: (event) => {
		if (event.key !== "b" || !(event.metaKey || event.ctrlKey)) return Option.none()
		event.preventDefault()
		return Option.some(Message.PressedSidebarShortcut())
	},
})

/**
 * `GlobalShortcuts`' document keydown: Mod+K opens the palette anywhere; `?`, `T` and `/` only
 * outside fields and dialogs, and not after an element handled the key (stopped propagation).
 */
export const globalShortcuts: Stream.Stream<Message> = Dom.streamFromEventFilterMap({
	target: () => document,
	type: "keydown",
	filterMapEvent: (event): Option.Option<Message> => {
		const key = Str.toLowerCase(pressedKey(event))
		if ((event.metaKey || event.ctrlKey) && key === "k") {
			event.preventDefault()
			return Option.some(Message.PressedPaletteShortcut())
		}
		if (
			event.defaultPrevented ||
			isEditableTarget(event.target) ||
			isDialogOpen() ||
			event.metaKey ||
			event.ctrlKey ||
			event.altKey
		)
			return Option.none()
		const message =
			event.key === "?"
				? Message.PressedShortcutsKey()
				: key === "t"
					? Message.PressedThemeKey()
					: event.key === "/"
						? Message.PressedFocusSearchKey()
						: null
		if (message !== null) event.preventDefault()
		return Option.fromNullishOr(message)
	},
})

const favoritesTarget: Dom.TypedEventTarget<{ [DASHBOARD_FAVORITES_EVENT]: Event }> = window

/** `dashboardFavoritesAtom`'s subscribers: the list starred or unstarred a dashboard. */
export const favoritesChanges: Stream.Stream<Message> = Dom.streamFromEvent({
	target: favoritesTarget,
	type: DASHBOARD_FAVORITES_EVENT,
	mapEvent: () => Message.ChangedDashboardFavorites({ favorites: readDashboardFavorites() }),
})

/** When the on-call pill next reads the schedules again: the soonest handoff, if any. */
export const onCallHandoffAt = (model: Model): number | null =>
	Option.getOrNull(Option.flatMapNullishOr(AsyncData.getData(model.onCall), nextHandoffMs))

/** Waits out the handoff (and a few seconds for the API to agree), then asks again. */
export const onCallHandoff = (atMs: number): Stream.Stream<Message> =>
	Stream.fromEffect(
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			yield* Effect.sleep(Duration.millis(Math.max(0, atMs - now) + 5_000))
			return Message.ElapsedOnCallHandoff()
		}),
	)
