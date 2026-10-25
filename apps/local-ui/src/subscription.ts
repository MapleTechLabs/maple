import * as ServiceMap from "@maple/web/service-map/map/service-map"
import { Option, Schema, Stream } from "effect"
import { Dom, Subscription } from "foldkit"
import { MOBILE_QUERY } from "./env"
import { Message } from "./message"
import type { Model } from "./model"
import { PageMessage } from "./page/registry"
import * as ServiceMapPage from "./page/service-map"

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

/** The open map's particle gate; a fresh map starts reduced until this first emits. */
const mapReducedMotion: Stream.Stream<Message> = Stream.map(ServiceMap.reducedMotionChanges, (message) =>
	Message.GotPageMessage({
		message: PageMessage.GotServiceMapMessage({
			message: ServiceMapPage.Message.GotMapMessage({ message }),
		}),
	}),
)

const viewportChanges: Stream.Stream<Message> = Dom.streamFromMediaQuery({
	query: MOBILE_QUERY,
	mapMatches: (isMobile) => Message.ChangedViewport({ isMobile }),
})

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
	viewport: entry(
		{},
		{
			modelToDependencies: () => ({}),
			dependenciesToStream: () => viewportChanges,
		},
	),
	colorScheme: entry(
		{},
		{
			modelToDependencies: () => ({}),
			dependenciesToStream: () => colorScheme,
		},
	),
	mapReducedMotion: entry(
		{ hasMap: Schema.Boolean },
		{
			modelToDependencies: (model) => ({
				hasMap: model.page._tag === "ServiceMapPage" && Option.isSome(model.page.maybeMap),
			}),
			dependenciesToStream: ({ hasMap }) => (hasMap ? mapReducedMotion : Stream.empty),
		},
	),
	sidebarShortcut: entry(
		{},
		{
			modelToDependencies: () => ({}),
			dependenciesToStream: () => sidebarShortcut,
		},
	),
}))
