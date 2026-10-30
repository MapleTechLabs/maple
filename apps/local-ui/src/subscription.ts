import { Option } from "effect"
import { Dom } from "foldkit"
import { MOBILE_QUERY } from "./env"
import { Message } from "./message"
import { ApplicationDefinition } from "./page/application-definition"

// The OS theme and the sidebar's ⌘B / Ctrl+B shortcut (`SidebarProvider`). The open service
// map's reduced-motion gate is the map Block's own Subscription.

const SIDEBAR_KEYBOARD_SHORTCUT = "b"

type ShortcutMessage = ReturnType<typeof Message.PressedSidebarShortcut>

const colorScheme = Dom.streamFromMediaQuery({
	query: "(prefers-color-scheme: light)",
	mapMatches: (prefersLight) => Message.ChangedColorScheme({ theme: prefersLight ? "light" : "dark" }),
})

const sidebarShortcut = Dom.streamFromEventFilterMap({
	target: () => window,
	type: "keydown",
	filterMapEvent: (event) => {
		if (event.key !== SIDEBAR_KEYBOARD_SHORTCUT || !(event.metaKey || event.ctrlKey)) return Option.none<ShortcutMessage>()
		event.preventDefault()
		return Option.some(Message.PressedSidebarShortcut())
	},
})

const viewportChanges = Dom.streamFromMediaQuery({
	query: MOBILE_QUERY,
	mapMatches: (isMobile) => Message.ChangedViewport({ isMobile }),
})

export const subscriptions = ApplicationDefinition.makeSubscriptions((entry) => ({
	viewport: entry("LocalViewport", {
		messages: [Message.ChangedViewport],
		handler: function* () {
			return () => viewportChanges
		},
	}),
	colorScheme: entry("LocalColorScheme", {
		messages: [Message.ChangedColorScheme],
		handler: function* () {
			return () => colorScheme
		},
	}),
	sidebarShortcut: entry("LocalSidebarShortcut", {
		messages: [Message.PressedSidebarShortcut],
		handler: function* () {
			return () => sidebarShortcut
		},
	}),
}))
