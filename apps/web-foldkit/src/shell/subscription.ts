import { Option, Stream } from "effect"
import { Dom } from "foldkit"
import { Message } from "./message"

/** `useIsMobile` (`max-md`): below 768px the sidebar is a sheet. */
export const MOBILE_QUERY = "(max-width: 767px)"

export const viewportChanges: Stream.Stream<Message> = Dom.streamFromMediaQuery({
	query: MOBILE_QUERY,
	mapMatches: (isMobile) => Message.ChangedViewport({ isMobile }),
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
