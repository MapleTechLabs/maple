import type { Resources } from "./platform/resources"
import * as Dialog from "@maple/web/ui/dialog"
import * as Popover from "@maple/web/ui/popover"
import * as Tabs from "@maple/web/ui/tabs"
import * as Toast from "@maple/web/ui/toast"
import { Option, Result } from "effect"
import { AsyncData, Command, type Update } from "foldkit"
import { UrlRequest } from "foldkit/navigation"
import { ApplyTheme, LoadExternal, Navigate, SaveSidebarState, WaitBeforeProbe } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { hashOf, locationOf, routeOf, trackVisit } from "./navigation"
import { updateCopy } from "./page/kit/copies"
import { pageKeyOf } from "./page/registry"
import { nextProbeDelayMs, nextServerState } from "./server/derive"
import {
	enterLocation,
	filterDrawerStep,
	probe,
	retryStaleData,
	type RootReturn,
	updatePageMessage,
} from "./update-page"

type UpdateReturn = Update.Return<Model, Message, Resources>

/** `toggleSidebar`: the sheet below `md`, else the rail (and its cookie). */
const toggleSidebar = (model: Model): RootReturn => {
	if (model.isMobile) return { model: { ...model, isSidebarOpenMobile: !model.isSidebarOpenMobile } }
	const isOpen = !model.isSidebarOpen
	return { model: { ...model, isSidebarOpen: isOpen }, commands: [SaveSidebarState({ isOpen })] }
}

/** A hash link: the browser ignores a click on the current hash; anything else is a new entry. */
const followLink = (model: Model, request: UrlRequest): RootReturn =>
	UrlRequest.match<RootReturn>(request, {
		Internal: ({ url }) =>
			hashOf(url) === (model.visited[model.visited.length - 1] ?? "")
				? { model: { ...model, isSidebarOpenMobile: false } }
				: {
						model: { ...model, isSidebarOpenMobile: false },
						commands: [Navigate({ hash: `#${hashOf(url)}`, isReplace: false })],
					},
		External: ({ href }) => ({ model, commands: [LoadExternal({ href })] }),
	})

/** The fragment changed (a link, Back, or a page's own navigation). */
const changeUrl = (model: Model, url: Parameters<typeof locationOf>[0]): RootReturn => {
	const location = locationOf(url)
	const previousKey = pageKeyOf(model.route)
	const next = {
		...model,
		location,
		route: routeOf(location),
		visited: trackVisit(model.visited, hashOf(url), model.isReplacing),
		isReplacing: false,
	}
	return enterLocation(next, previousKey)
}

const presenceSettled = (model: Model, presence: Model["presence"]): RootReturn => ({
	model: { ...model, presence },
})

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		ClickedLink: ({ request }) => followLink(model, request),
		ChangedUrl: ({ url }) => changeUrl(model, url),
		CompletedNavigate: () => ({ model }),
		CompletedRememberRange: () => ({ model }),
		CompletedProbeServer: ({ outcome, checkedAtMs }) => {
			const server = nextServerState(model.maybeServer, outcome, checkedAtMs)
			const version = model.probe.version + 1
			return {
				model: {
					...model,
					maybeServer: Option.some(server),
					probe: { isInFlight: false, version },
					hasIngested: model.hasIngested || server.lastIngestAtMs !== null,
				},
				commands: [WaitBeforeProbe({ version, delayMs: nextProbeDelayMs(server) })],
			}
		},
		ElapsedProbeDelay: ({ version }) => (version === model.probe.version ? probe(model) : { model }),
		ClickedRetryConnection: () => probe(model),
		ClickedRetryStaleData: () => retryStaleData(model),
		ClickedToggleSidebar: () => toggleSidebar(model),
		PressedSidebarShortcut: () => toggleSidebar(model),
		CompletedSaveSidebarState: () => ({ model }),
		ChangedViewport: ({ isMobile }) => ({ model: { ...model, isMobile, isSidebarOpenMobile: false } }),
		DismissedMobileNav: () => ({ model: { ...model, isSidebarOpenMobile: false } }),
		GotFilterDrawerMessage: ({ message: child }) =>
			filterDrawerStep(model, Dialog.update(model.filterDrawer, child)),
		GotInstallTabsMessage: ({ message: child }) => {
			const next = Tabs.update(model.installTabs, child)
			return {
				model: { ...model, installTabs: next.model },
				commands: Command.mapMessages(next.commands ?? [], (tabs) =>
					Message.GotInstallTabsMessage({ message: tabs }),
				),
			}
		},
		GotConnectMessage: ({ message: child }) => {
			const next = Popover.update(model.connect, child)
			return {
				model: { ...model, connect: next.model },
				commands: Command.mapMessages(next.commands ?? [], (popover) =>
					Message.GotConnectMessage({ message: popover }),
				),
			}
		},
		ChangedColorScheme: ({ theme }) => ({
			model: { ...model, theme },
			commands: [ApplyTheme({ theme })],
		}),
		CompletedApplyTheme: () => ({ model }),
		SucceededFetchSignalPresence: ({ result }) =>
			presenceSettled(model, AsyncData.Success({ data: result })),
		FailedFetchSignalPresence: ({ failure }) =>
			presenceSettled(model, AsyncData.settle(model.presence, Result.fail(failure))),
		ReusedSignalPresence: () =>
			presenceSettled(
				model,
				Option.match(AsyncData.getData(model.presence), {
					onNone: () => model.presence,
					onSome: (data) => AsyncData.Success({ data }),
				}),
			),
		GotCopyMessage: ({ id, message: child }) => {
			const next = updateCopy(model.copies, id, child, (copyId, copyMessage) =>
				Message.GotCopyMessage({ id: copyId, message: copyMessage }),
			)
			return { model: { ...model, copies: next.copies }, commands: next.commands }
		},
		GotToastMessage: ({ message: child }) => {
			const next = Toast.update(model.toasts, child)
			return {
				model: { ...model, toasts: next.model },
				commands: Command.mapMessages(next.commands ?? [], (toast) =>
					Message.GotToastMessage({ message: toast }),
				),
			}
		},
		GotPageMessage: ({ message: child }) => updatePageMessage(model, child),
		CompletedCancelPageFetch: () => ({ model }),
	})
