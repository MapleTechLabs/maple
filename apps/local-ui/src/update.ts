import { Option, Result } from "effect"
import { AsyncData, Update } from "foldkit"
import { UrlRequest } from "foldkit/navigation"
import type { Url } from "foldkit/url"
import { ApplyTheme, LoadExternal, Navigate, SaveSidebarState, WaitBeforeProbe } from "./command"
import { ApplicationComposition } from "./composition"
import { Message } from "./message"
import type { Model } from "./model"
import { hashOf, locationOf, routeOf, trackVisit } from "./navigation"
import { updateCopy } from "./page/kit/copies"
import { ApplicationDefinition } from "./page/application-definition"
import { pageKeyOf } from "./page/page-model"
import { nextProbeDelayMs, nextServerState } from "./server/derive"
import { LOGIN_PATH } from "./server/state"
import { enterLocationStep, probeStep, retryStaleDataStep } from "./update-page"

const { makeStep, makeNoopStep } = ApplicationDefinition

/** `toggleSidebar`: the sheet below `md`, else the rail (and its cookie). */
const toggleSidebarStep = makeStep((model: Model) => {
	if (model.isMobile) return { model: { ...model, isSidebarOpenMobile: !model.isSidebarOpenMobile } }
	const isOpen = !model.isSidebarOpen
	return { model: { ...model, isSidebarOpen: isOpen }, commands: [SaveSidebarState({ isOpen })] }
})

/** A hash link: the browser ignores a click on the current hash; anything else is a new entry. */
const followLink = (model: Model, request: UrlRequest) =>
	UrlRequest.match(request, {
		Internal: ({ url }) =>
			hashOf(url) === (model.visited[model.visited.length - 1] ?? "")
				? { model: { ...model, isSidebarOpenMobile: false } }
				: {
						model: { ...model, isSidebarOpenMobile: false },
						commands: [Navigate({ hash: `#${hashOf(url)}`, isReplace: false })],
					},
		External: ({ href }) => ({ model, commands: [LoadExternal({ href })] }),
	})

/** The fragment changed (a link, Back, or a page's own navigation): record it, then enter it. */
const changedUrlStep = (url: Url) =>
	makeStep((model: Model) => {
		const location = locationOf(url)
		return {
			model: {
				...model,
				location,
				route: routeOf(location),
				visited: trackVisit(model.visited, hashOf(url), model.isReplacing),
				isReplacing: false,
			},
		}
	})

const presenceSettled = (model: Model, presence: Model["presence"]) => ({ model: { ...model, presence } })

export const update = ApplicationComposition.makeUpdate({
	ClickedLink: (model, { request }) => followLink(model, request),
	ChangedUrl: (model, { url }) =>
		Update.combineSteps(model, [changedUrlStep(url), enterLocationStep(pageKeyOf(model.route))]),
	CompletedNavigate: makeNoopStep(),
	CompletedRememberRange: makeNoopStep(),
	CompletedProbeServer: (model, { outcome, checkedAtMs }) => {
		// A self-hosted server with an access token answers 401 once the session is gone.
		if (outcome._tag === "Rejected" && outcome.status === 401 && !model.env.isHosted)
			return { model, commands: [LoadExternal({ href: LOGIN_PATH })] }
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
	ElapsedProbeDelay: (model, { version }) => (version === model.probe.version ? probeStep(model) : { model }),
	ClickedRetryConnection: probeStep,
	ClickedRetryStaleData: retryStaleDataStep,
	ClickedToggleSidebar: toggleSidebarStep,
	PressedSidebarShortcut: toggleSidebarStep,
	CompletedSaveSidebarState: makeNoopStep(),
	ChangedViewport: (model, { isMobile }) => ({ model: { ...model, isMobile, isSidebarOpenMobile: false } }),
	DismissedMobileNav: (model) => ({ model: { ...model, isSidebarOpenMobile: false } }),
	ChangedColorScheme: (model, { theme }) => ({ model: { ...model, theme }, commands: [ApplyTheme({ theme })] }),
	CompletedApplyTheme: makeNoopStep(),
	SucceededFetchSignalPresence: (model, { result }) => presenceSettled(model, AsyncData.Success({ data: result })),
	FailedFetchSignalPresence: (model, { failure }) =>
		presenceSettled(model, AsyncData.settle(model.presence, Result.fail(failure))),
	ReusedSignalPresence: (model) =>
		presenceSettled(
			model,
			Option.match(AsyncData.getData(model.presence), {
				onNone: () => model.presence,
				onSome: (data) => AsyncData.Success({ data }),
			}),
		),
	ReceivedCopyMessage: (model, { message }) => {
		const next = updateCopy(model.copies, message, (copyMessage) => Message.ReceivedCopyMessage({ message: copyMessage }))
		return { model: { ...model, copies: next.copies }, commands: next.commands }
	},
	CompletedCancelPageFetch: makeNoopStep(),
})
