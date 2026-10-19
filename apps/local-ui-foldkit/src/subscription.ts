import { Option, Stream } from "effect"
import { Dom, Subscription } from "foldkit"
import { MOBILE_QUERY } from "./env"
import { Message } from "./message"
import type { Model } from "./model"

// The OS theme and the sidebar's ⌘B / Ctrl+B shortcut (`SidebarProvider`).

const SIDEBAR_KEYBOARD_SHORTCUT = "b"

const colorScheme: Stream.Stream<Message> = Dom.streamFromMediaQuery({
	query: "(prefers-color-scheme: light)",
	mapMatches: (prefersLight) => Message.ChangedColorScheme({ theme: prefersLight ? "light" : "dark" }),
})

const sidebarShortcut: Stream.Stream<Message> = Dom.streamFromEventFilterMap({
	target: () => window,
	type: "keydown",
	filterMapEvent: (event): Option.Option<Message> => {
		if (event.key !== SIDEBAR_KEYBOARD_SHORTCUT || !(event.metaKey || event.ctrlKey)) return Option.none()
		event.preventDefault()
		return Option.some(Message.PressedSidebarShortcut())
	},
})

const viewportChanges: Stream.Stream<Message> = Dom.streamFromMediaQuery({
	query: MOBILE_QUERY,
	mapMatches: (isMobile) => Message.ChangedViewport({ isMobile }),
})

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
	viewport: entry({}, {
		modelToDependencies: () => ({}),
		dependenciesToStream: () => viewportChanges,
	}),
	colorScheme: entry({}, {
		modelToDependencies: () => ({}),
		dependenciesToStream: () => colorScheme,
	}),
	sidebarShortcut: entry({}, {
		modelToDependencies: () => ({}),
		dependenciesToStream: () => sidebarShortcut,
	}),
}))
