import * as LogsStream from "@maple/views/ui/logs/logs-stream"
import * as ServiceMap from "@maple/views/service-map/map/service-map"
import * as TooltipHost from "@maple/views/ui/tooltip-host"
import { Option, Schema, Stream } from "effect"
import { Dom, Subscription } from "foldkit"
import { MOBILE_QUERY } from "./env"
import { Message } from "./message"
import type { Model } from "./model"
import { PageMessage } from "./page/registry"
import { queryOf } from "./route"
import * as LogsPage from "./page/logs"
import { modeOf } from "./page/logs/filters"
import * as ServiceMapPage from "./page/service-map"

// The OS theme, the sidebar's ⌘B / Ctrl+B shortcut (`SidebarProvider`) and the logs list's keys.

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

/** The logs stream's j/k/↑/↓, Enter, Escape and →/← keys. */
const logsNavigationKeys: Stream.Stream<Message> = Stream.map(LogsStream.navigationKeys, (message) =>
	Message.GotPageMessage({
		message: PageMessage.GotLogsMessage({ message: LogsPage.Message.GotStreamMessage({ message }) }),
	}),
)

const viewportChanges: Stream.Stream<Message> = Dom.streamFromMediaQuery({
	query: MOBILE_QUERY,
	mapMatches: (isMobile) => Message.ChangedViewport({ isMobile }),
})

const tooltipTriggers: Stream.Stream<Message> = Stream.map(TooltipHost.triggerEvents, (message) =>
	Message.GotTooltipMessage({ message }),
)

const tooltipWhileOpen: Stream.Stream<Message> = Stream.map(TooltipHost.whileOpen, (message) =>
	Message.GotTooltipMessage({ message }),
)

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
	/** The app-wide tooltip: pointer, press and focus on any `tooltipTrigger`. */
	tooltipTriggers: entry(
		{},
		{
			modelToDependencies: () => ({}),
			dependenciesToStream: () => tooltipTriggers,
		},
	),
	/** Escape and live text for the open tooltip. */
	tooltipWhileOpen: entry(
		{ isOpen: Schema.Boolean },
		{
			modelToDependencies: (model) => ({ isOpen: TooltipHost.isOpen(model.tooltip) }),
			dependenciesToStream: ({ isOpen }) => (isOpen ? tooltipWhileOpen : Stream.empty),
		},
	),
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
	/** While the logs list shows rows (`useListNavigation`). */
	logsNavigationKeys: entry(
		{ hasLogRows: Schema.Boolean },
		{
			modelToDependencies: (model) => ({
				hasLogRows:
					model.page._tag === "LogsPage" &&
					model.page.stream.rows.length > 0 &&
					modeOf(queryOf(model.location)) === "list",
			}),
			dependenciesToStream: ({ hasLogRows }) => (hasLogRows ? logsNavigationKeys : Stream.empty),
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
