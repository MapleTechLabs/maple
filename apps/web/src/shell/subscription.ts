import { isDialogOpen, isEditableTarget, pressedKey } from "@maple/ui/lib/keyboard"
import { Clock, Duration, Effect, Option, Stream, String as Str } from "effect"
import { Dom } from "foldkit"
import { DASHBOARD_FAVORITES_EVENT, readDashboardFavorites } from "./favorites"
import { Message } from "./message"
import type { Model } from "./model"
import { ONCALL_CHANGED_EVENT } from "../page/alerts/shared/oncall-schedules"

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

/** When the on-call pill next reads the schedules; `null` while one is in flight or none is due. */
export const onCallReadAt = (model: Model): number | null => model.onCallNextReadAtMs

/** Waits until the pill's next read is due. */
export const onCallTimer = (atMs: number): Stream.Stream<Message> =>
	Stream.fromEffect(
		Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			yield* Effect.sleep(Duration.millis(Math.max(0, atMs - now)))
			return Message.ElapsedOnCallTimer({ nowMs: yield* Clock.currentTimeMillis })
		}),
	)

/** The tab came back into view or focus (a handoff may have passed while it slept). */
// Suspended: `window` and `document` are read on subscribe, so importing the shell needs no DOM.
export const onCallWakes: Stream.Stream<Message> = Stream.suspend(() => {
	const wakeTarget: Dom.TypedEventTarget<{ focus: FocusEvent }> = window
	return Stream.merge(
		Dom.streamFromEvent({ target: wakeTarget, type: "focus", mapEvent: () => true }),
		Dom.streamFromEvent({
			target: document,
			type: "visibilitychange",
			mapEvent: () => document.visibilityState === "visible",
		}),
	)
}).pipe(
	Stream.filter((isAwake) => isAwake),
	Stream.mapEffect(() => Clock.currentTimeMillis),
	Stream.map((nowMs) => Message.WokeOnCall({ nowMs })),
)

/** A page wrote a schedule or an override. */
export const onCallChanges: Stream.Stream<Message> = Stream.suspend(() => {
	const target: Dom.TypedEventTarget<{ [ONCALL_CHANGED_EVENT]: Event }> = window
	return Dom.streamFromEvent({
		target,
		type: ONCALL_CHANGED_EVENT,
		mapEvent: () => Message.ChangedOnCallSchedules(),
	})
})
