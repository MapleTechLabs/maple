import { Option, Stream } from "effect"
import { Dom } from "foldkit"
import { DASHBOARD_FAVORITES_EVENT, readDashboardFavorites } from "./favorites"
import { Message } from "./message"

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

const favoritesTarget: Dom.TypedEventTarget<{ [DASHBOARD_FAVORITES_EVENT]: Event }> = window

/** `dashboardFavoritesAtom`'s subscribers: the list starred or unstarred a dashboard. */
export const favoritesChanges: Stream.Stream<Message> = Dom.streamFromEvent({
	target: favoritesTarget,
	type: DASHBOARD_FAVORITES_EVENT,
	mapEvent: () => Message.ChangedDashboardFavorites({ favorites: readDashboardFavorites() }),
})
