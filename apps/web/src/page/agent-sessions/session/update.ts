import { buildSessionSummary, buildSessionTurns, resolveWindow } from "@maple/agent-sessions"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { Option } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import type { TimeWindow } from "../../../data/time-range"
import type { Resources } from "../../../platform/resources"
import { AppRoute, hrefOf } from "../../../route"
import type { AgentSessionSearch } from "../../../route/search"
import * as Canvas from "../../../service-map/xyflow/canvas"
import * as CopyButton from "../../../ui/copy-button"
import * as Popover from "../../../ui/popover"
import * as Tabs from "../../../ui/tabs"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { missingDetection } from "../kit/detected-models"
import {
	DetectModels,
	FetchFirstPage,
	FetchMorePage,
	FetchTotals,
	MIN_PAGE_SIZE,
	PAGE_SIZE,
	ParseMarkdown,
	ResolveClock,
	RunCodeAction,
	WaitCodeCopied,
	ScrollToTools,
} from "./command"
import { loadedSpans, progressOf, sessionData, viewOf } from "./derive"
import { INITIAL_LOCALE } from "../../kit/locale"
import { Message } from "./message"
import { type Model, SESSION_VIEWS, type SpansPage } from "./model"
import { layoutLanes, MAX_ZOOM, MIN_ZOOM } from "./flow-layout"
import { freshLists, land, moveCursor, type SpanKey } from "./navigation"
import * as Dialog from "../../../ui/dialog"
import type { Message as SpanPanelMessage } from "../../traces/detail/span-panel/message"
import * as SpanPanel from "../../traces/detail/span-panel/update"
import { SPAN_DIALOG_ID } from "./span-popover"
import {
	checkedCloseFocus,
	CLOSE_TOOLTIP_ID,
	followPopover,
	freshSpanPanel,
	liftDialog,
	popoverMarkdownTexts,
	stepCloseTooltip,
} from "./span-popover-update"
import * as Tooltip from "../../../ui/tooltip"
import { disclosed } from "./payload-view"
import { markdownTexts, textHash, transcriptRows } from "./transcript-rows"

type Return = PageReturn<Model, Message>
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>
export type Search = typeof AgentSessionSearch.Type

/** The id base of this page's Tabs. */
const TABS_ID_BASE = 58

const windowOf = (search: Search): TimeWindow | null => resolveWindow(search.t, search.end) ?? null

const spansKey = (context: PageContext, sessionId: string, window: TimeWindow | null) =>
	requestKey(context.orgId, "getAiSessionSpans", {
		sessionId,
		startTime: window?.startTime,
		endTime: window?.endTime,
	})

const nothingLoaded = (key: string): Model["more"] => ({
	key,
	agentPages: [],
	appPages: [],
	status: "loading",
	limit: PAGE_SIZE,
})

/** The search string the route renders, for the back-to-list crumb. */
export const searchStrOf = (sessionId: string, search: Search): string => {
	const href = hrefOf(AppRoute.AgentSession({ sessionId, search }))
	const at = href.indexOf("?")
	return at === -1 ? "" : href.slice(at)
}

/** The first page for the link's window (or the id across retention without one). */
const requestFirstPage = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const window = windowOf(model.search)
	const key = spansKey(context, model.sessionId, window)
	return Option.match(Keyed.request(model.firstPage, key, mode), {
		onNone: () => ({ model }),
		onSome: (firstPage) => ({
			model: { ...model, firstPage },
			commands: [FetchFirstPage({ key, sessionId: model.sessionId, window })],
		}),
	})
}

const landedCount = (more: Model["more"]): number => more.agentPages.length + more.appPages.length

/** The next background page, if the session did not fit: every agent page, then every app page. */
const nextPage = (model: Model): Commands => {
	const first = Option.getOrUndefined(AsyncData.getData(model.firstPage.data))
	const key = model.firstPage.key
	if (first === undefined || first.nextCursor === null || key === null) return []
	if (model.more.key !== key || model.more.status !== "loading") return []
	const lastAgent = model.more.agentPages.at(-1)
	const lastApp = model.more.appPages.at(-1)
	const agentCursor = lastAgent === undefined ? first.nextCursor : lastAgent.nextCursor
	const window = windowOf(model.search)
	const fetch = (scope: "ai" | "app", after: NonNullable<SpansPage["nextCursor"]>) => [
		FetchMorePage({
			key,
			sessionId: model.sessionId,
			window,
			scope,
			after,
			limit: model.more.limit,
			index: landedCount(model.more),
		}),
	]
	if (agentCursor !== null) return fetch("ai", agentCursor)
	const appCursor = lastApp === undefined ? first.nextCursor : lastApp.nextCursor
	return appCursor === null ? [] : fetch("app", appCursor)
}

/**
 * What follows the spans in hand: the totals read (only for a session larger than a page), model
 * detection for the views that draw model marks, and the link's bounds stamped into the URL.
 */
const follow =
	(context: PageContext) =>
	(result: Return): Return => {
		const { model } = result
		const first = Option.getOrUndefined(AsyncData.getData(model.firstPage.data))
		if (first === undefined || first.data.length === 0) return result
		const spans = loadedSpans(model)
		const progress = progressOf(model, spans)
		const window = windowOf(model.search)
		const totalsKey = requestKey(context.orgId, "getAiSessionSummary", {
			sessionId: model.sessionId,
			startTime: window?.startTime,
			endTime: window?.endTime,
		})
		const totalsStep =
			progress === undefined
				? Option.none()
				: Option.map(Keyed.request(model.totals, totalsKey, "Load"), (totals) => ({
						totals,
						command: FetchTotals({ key: totalsKey, sessionId: model.sessionId, window }),
					}))
		const withTotals: Model = Option.match(totalsStep, {
			onNone: () => model,
			onSome: ({ totals }) => ({ ...model, totals }),
		})
		const turns = buildSessionTurns(spans)
		const summary = buildSessionSummary({ spans, turns })
		const view = viewOf(model.search.view)
		const detectKey =
			view === "overview" || view === "trace"
				? missingDetection(
						model.detections,
						summary.models.map((usage) => usage.model),
					)
				: Option.none()
		const detections = Option.match(detectKey, {
			onNone: () => withTotals.detections,
			onSome: (key) => ({ ...withTotals.detections, [key]: null }),
		})
		const totals = Option.getOrUndefined(AsyncData.getData(withTotals.totals.data))
		const canStamp = model.search.t === undefined && (progress === undefined || totals !== undefined)
		const startMs = totals?.startTime === undefined ? summary.startMs : toEpochMs(totals.startTime)
		const endMs = totals?.endTime === undefined ? summary.endMs : toEpochMs(totals.endTime)
		return {
			model: { ...withTotals, detections },
			commands: [
				...(result.commands ?? []),
				...Option.match(totalsStep, { onNone: () => [], onSome: ({ command }) => [command] }),
				...Option.match(detectKey, { onNone: () => [], onSome: (key) => [DetectModels({ key })] }),
			],
			outMessage: canStamp
				? PageOutMessage.RequestedNavigation({
						url: hrefOf(
							AppRoute.AgentSession({
								sessionId: model.sessionId,
								search: {
									...model.search,
									t: formatWarehouseDateTime(startMs),
									end: formatWarehouseDateTime(endMs),
								},
							}),
						),
						isReplace: true,
					})
				: result.outMessage,
		}
	}

const navigate = (model: Model, search: Search, isReplace: boolean): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefOf(AppRoute.AgentSession({ sessionId: model.sessionId, search })),
		isReplace,
	}),
})

/** A relayout of the open Flow view: edges then draw from measured handles. */
const isFlowOpen = (model: Model): boolean => viewOf(model.search.view) === "flow"

const toggledIn = (values: ReadonlyArray<string>, value: string): ReadonlyArray<string> =>
	values.includes(value) ? values.filter((candidate) => candidate !== value) : [...values, value]

export const init = (
	route: { readonly sessionId: string; readonly search: Search },
	context: PageContext,
): Return => {
	const view = viewOf(route.search.view)
	const model: Model = {
		sessionId: route.sessionId,
		search: route.search,
		searchStr: searchStrOf(route.sessionId, route.search),
		nowMs: 0,
		locale: INITIAL_LOCALE,
		firstPage: Keyed.idle(),
		more: nothingLoaded(""),
		totals: Keyed.idle(),
		detections: {},
		tabs: Tabs.init({ idBase: TABS_ID_BASE, values: SESSION_VIEWS, selected: view }),
		displayPopover: Popover.init("agent-session-display", { align: "end" }),
		query: route.search.tool ?? "",
		options: {
			agentSpansOnly: true,
			collapseIdle: true,
			mergeRepeats: false,
			showThinking: true,
			showPayloads: false,
		},
		collapsedTurns: [],
		openRows: [],
		checksChoice: { passed: null, skipped: null },
		ledgerOpen: null,
		revealedSpanId: null,
		copy: CopyButton.init(),
		markdown: {},
		clampedBodies: [],
		payloadCopy: { key: null, copy: CopyButton.init() },
		flowCanvas: Canvas.init({ minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM, fitOnInit: Option.none() }),
		isFlowRelaid: false,
		...freshLists,
		spanDialog: Dialog.init(SPAN_DIALOG_ID, "dialog"),
		spanTab: null,
		spanPanel: freshSpanPanel(),
		spanPanelId: null,
		closeTooltip: Tooltip.init(CLOSE_TOOLTIP_ID),
		codeCopy: { code: null, generation: 0 },
	}
	const first = requestFirstPage(model, context, "Load")
	return { ...first, commands: [...(first.commands ?? []), ResolveClock()] }
}

/** A search change: the window may have been stamped (a new read), the view or the span moved. */
export const routeChanged = (
	model: Model,
	route: { readonly sessionId: string; readonly search: Search },
	context: PageContext,
): Return => {
	const view = viewOf(route.search.view)
	const isSameView = viewOf(model.search.view) === view
	const base: Model = isSameView ? model : { ...model, ...freshLists }
	const next: Model = {
		...base,
		isFlowRelaid: isSameView && model.isFlowRelaid,
		search: route.search,
		searchStr: searchStrOf(route.sessionId, route.search),
		tabs: model.tabs.selected === view ? model.tabs : { ...model.tabs, selected: view },
	}
	return followPopover(context)(
		followLanding(followMarkdown(follow(context)(requestFirstPage(next, context, "Load")))),
	)
}

export const contextChanged = (model: Model): Return => ({ model })

const acceptMore = (model: Model, message: Extract<Message, { _tag: "CompletedFetchMorePage" }>): Model => {
	const { key, index, scope, result } = message
	if (key !== model.firstPage.key) return model
	const more = model.more.key === key ? model.more : nothingLoaded(key)
	if (index !== landedCount(more) || more.status !== "loading") return model
	if (result._tag === "Failure") {
		return message.isTooLarge && more.limit > MIN_PAGE_SIZE
			? { ...model, more: { ...more, limit: Math.max(MIN_PAGE_SIZE, Math.floor(more.limit / 2)) } }
			: { ...model, more: { ...more, status: "failed" } }
	}
	const page = result.success
	const isAppDone = scope === "app" && page.nextCursor === null
	return {
		...model,
		more: {
			...more,
			agentPages: scope === "ai" ? [...more.agentPages, page] : more.agentPages,
			appPages: scope === "app" ? [...more.appPages, page] : more.appPages,
			status: isAppDone ? "complete" : more.status,
		},
	}
}

/** The background drain: one page in flight at a time, the next asked for as each lands. */
const drain = (result: Return): Return => ({
	...result,
	commands: [...(result.commands ?? []), ...nextPage(result.model)],
})

/** The transcript's markdown bodies not parsed yet, marked in flight and asked for in one batch. */
const followMarkdown = (result: Return): Return => {
	const { model } = result
	if (!AsyncData.hasData(model.firstPage.data)) return result
	const texts = [
		...(viewOf(model.search.view) === "transcript"
			? markdownTexts(model, transcriptRows(model, sessionData(model)))
			: []),
		...popoverMarkdownTexts(model),
	]
	const missing = [
		...new Map(
			texts
				.map((text) => [textHash(text), text] as const)
				.filter(([hash]) => !(hash in model.markdown)),
		),
	]
	if (missing.length === 0) return result
	return {
		...result,
		model: {
			...model,
			markdown: { ...model.markdown, ...Object.fromEntries(missing.map(([hash]) => [hash, null])) },
		},
		commands: [...(result.commands ?? []), ParseMarkdown({ texts: missing.map(([, text]) => text) })],
	}
}

const followLanding = (result: Return): Return => ({ ...result, model: land(result.model) })

/**
 * Opening a span is a step Back may undo; moving the popover or closing it is not. The search is
 * set ahead of the round trip, so nothing re-opens the overlay while the URL catches up.
 */
const selectSpan = (model: Model, spanId: string | undefined): Return => {
	const search = { ...model.search, span: spanId }
	return navigate({ ...model, revealedSpanId: null, search }, search, model.search.span !== undefined)
}

const stepSpanDialog = (model: Model, message: Dialog.Message): Return => {
	const step = Dialog.update(model.spanDialog, message)
	const lifted = liftDialog(model, step)
	if (step.outMessage?._tag !== "Closed") return lifted
	const closed = selectSpan(lifted.model, undefined)
	return { ...closed, commands: [...(lifted.commands ?? []), ...(closed.commands ?? [])] }
}

const stepSpanPanel = (model: Model, message: SpanPanelMessage): Return => {
	const step = SpanPanel.updateState(model.spanPanel, message)
	return {
		model: { ...model, spanPanel: step.model },
		commands: Command.mapMessages(step.commands ?? [], (inner) =>
			Message.GotSpanPanelMessage({ message: inner }),
		),
	}
}

const pressedSpanKey = (model: Model, key: SpanKey): Return => {
	switch (key) {
		case "Next":
			return { model: moveCursor(model, 1) }
		case "Previous":
			return { model: moveCursor(model, -1) }
		case "Open":
			return model.focusedSpanId === null ? { model } : selectSpan(model, model.focusedSpanId)
		case "Escape":
			if (model.search.span !== undefined) return selectSpan(model, undefined)
			return { model: { ...model, focusedSpanId: null } }
	}
}

// A scroll tick or the close tooltip changes no transcript row, so no markdown body can be new.
const isMarkdownNeutral = (message: Message): boolean =>
	message._tag === "ChangedTranscriptWindow" ||
	message._tag === "ChangedWaterfallWindow" ||
	message._tag === "GotCloseTooltipMessage"

export const update = (model: Model, message: Message, context: PageContext): Return => {
	const followed = followPopover(context)(followLanding(step(model, message, context)))
	return isMarkdownNeutral(message) ? followed : followMarkdown(followed)
}

const step = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveClock: ({ nowMs, locale }) => ({ model: { ...model, nowMs, locale } }),
		CompletedFetchFirstPage: ({ key, result }) => {
			if (key !== model.firstPage.key) return { model }
			const accepted: Model = {
				...model,
				firstPage: Keyed.accept(model.firstPage, key, result),
				more: model.more.key === key ? model.more : nothingLoaded(key),
			}
			return drain(follow(context)({ model: accepted }))
		},
		// A dropped page asks for nothing: the drain's own request for that position is still in flight.
		CompletedFetchMorePage: (more) => {
			const accepted = acceptMore(model, more)
			return accepted === model ? { model } : drain(follow(context)({ model: accepted }))
		},
		CompletedFetchTotals: ({ key, result }) =>
			follow(context)({ model: { ...model, totals: Keyed.accept(model.totals, key, result) } }),
		CompletedDetectModels: ({ key, models }) => ({
			model: { ...model, detections: { ...model.detections, [key]: models } },
		}),
		ClickedRetryLoad: () =>
			model.more.status === "failed"
				? drain({ model: { ...model, more: { ...model.more, status: "loading" } } })
				: { model },
		GotTabsMessage: ({ message: inner }) => {
			const next = Tabs.update(model.tabs, inner)
			const commands = Command.mapMessages(next.commands ?? [], (tabs) =>
				Message.GotTabsMessage({ message: tabs }),
			)
			const changed = next.model.selected !== model.tabs.selected
			const updated: Model = {
				...model,
				tabs: next.model,
				revealedSpanId: changed ? null : model.revealedSpanId,
			}
			return changed
				? { ...navigate(updated, { ...model.search, view: next.model.selected }, false), commands }
				: { model: updated, commands }
		},
		PressedViewKey: ({ view }) =>
			view === model.tabs.selected
				? { model }
				: navigate({ ...model, revealedSpanId: null }, { ...model.search, view }, false),
		GotDisplayPopoverMessage: ({ message: inner }) => {
			const next = Popover.update(model.displayPopover, inner)
			return {
				model: { ...model, displayPopover: next.model },
				commands: Command.mapMessages(next.commands ?? [], (popover) =>
					Message.GotDisplayPopoverMessage({ message: popover }),
				),
			}
		},
		ChangedQuery: ({ value }) => ({ model: { ...model, query: value, isFlowRelaid: isFlowOpen(model) } }),
		ToggledOption: ({ option }) => ({
			model: {
				...model,
				options: { ...model.options, [option]: !model.options[option] },
				isFlowRelaid: isFlowOpen(model),
			},
		}),
		ToggledTurn: ({ turnId }) => ({
			model: { ...model, collapsedTurns: toggledIn(model.collapsedTurns, turnId) },
		}),
		ToggledRow: ({ key }) => ({ model: { ...model, openRows: toggledIn(model.openRows, key) } }),
		ClickedSpan: ({ spanId }) => selectSpan(model, spanId),
		ClickedWaterfallSpan: ({ spanId }) =>
			selectSpan(
				{ ...model, focusedSpanId: spanId },
				model.search.span === spanId ? undefined : spanId,
			),
		PressedSpanKey: ({ key }) => pressedSpanKey(model, key),
		GotSpanDialogMessage: ({ message: inner }) => stepSpanDialog(model, inner),
		GotSpanPanelMessage: ({ message: inner }) => stepSpanPanel(model, inner),
		PickedSpanTab: ({ tab }) => (tab === null ? { model } : { model: { ...model, spanTab: tab } }),
		ClickedCloseSpan: () => selectSpan(model, undefined),
		GotCloseTooltipMessage: ({ message: inner }) => stepCloseTooltip(model, inner),
		CheckedCloseFocus: ({ triggerId, isFocusVisible }) =>
			checkedCloseFocus(model, triggerId, isFocusVisible),
		ClickedOpenInTraceView: () => {
			const search = { ...model.search, span: undefined }
			return navigate(
				{ ...model, search, revealedSpanId: model.search.span ?? null },
				{ ...search, view: "trace" },
				false,
			)
		},
		ChangedWaterfallWindow: ({ window }) => ({ model: { ...model, waterfallWindow: window } }),
		ChangedTranscriptWindow: ({ window }) => ({ model: { ...model, transcriptWindow: window } }),
		ToggledChecks: ({ which, isOpen }) => ({
			model: { ...model, checksChoice: { ...model.checksChoice, [which]: isOpen } },
		}),
		ToggledLedgerTool: ({ name }) => ({
			model: { ...model, ledgerOpen: model.ledgerOpen === name ? null : name },
		}),
		ClickedOpenTools: () => ({ model, commands: [ScrollToTools()] }),
		CompletedScroll: () => ({ model }),
		GotCopyMessage: ({ message: inner }) => {
			const next = CopyButton.update(model.copy, inner)
			return {
				model: { ...model, copy: next.model },
				commands: Command.mapMessages(next.commands ?? [], (copy) =>
					Message.GotCopyMessage({ message: copy }),
				),
			}
		},
		GotFlowCanvasMessage: ({ message: inner }) => {
			const lanes = layoutLanes(sessionData(model).turns, {
				mergeRepeats: model.options.mergeRepeats,
				query: model.query,
				agentSpansOnly: model.options.agentSpansOnly,
			})
			const positions = lanes.flatMap((lane) =>
				lane.nodes.map((node) => ({ id: node.key, position: { x: node.x, y: node.y } })),
			)
			return { model: { ...model, flowCanvas: Canvas.update(model.flowCanvas, inner, positions) } }
		},
		// Streamdown writes nothing while its check is showing.
		ClickedCodeAction: ({ action, code, language }) =>
			action === "copy" && model.codeCopy.code === code
				? { model }
				: { model, commands: [RunCodeAction({ action, code, language })] },
		CompletedCodeAction: ({ code, isCopied }) => {
			if (!isCopied) return { model }
			const generation = model.codeCopy.generation + 1
			return {
				model: { ...model, codeCopy: { code, generation } },
				commands: [WaitCodeCopied({ generation })],
			}
		},
		ElapsedCodeCopied: ({ generation }) =>
			generation === model.codeCopy.generation
				? { model: { ...model, codeCopy: { code: null, generation } } }
				: { model },
		// "Top of the session at 1:1": a reset rather than a fit, which clamps unpredictably.
		ClickedResetFlowView: () => ({
			model: { ...model, flowCanvas: { ...model.flowCanvas, viewport: { x: 0, y: 0, zoom: 1 } } },
		}),
		PressedBodyView: ({ key, isRaw }) =>
			disclosed(model.openRows, key, false) === isRaw
				? { model }
				: { model: { ...model, openRows: toggledIn(model.openRows, key) } },
		MeasuredClamp: ({ key, isClamped }) =>
			model.clampedBodies.includes(key) === isClamped
				? { model }
				: { model: { ...model, clampedBodies: toggledIn(model.clampedBodies, key) } },
		CompletedParseMarkdown: ({ parsed }) => ({
			model: {
				...model,
				markdown: {
					...model.markdown,
					...Object.fromEntries(parsed.map(({ text, document }) => [textHash(text), { document }])),
				},
			},
		}),
		GotPayloadCopyMessage: ({ key, message: inner }) => {
			// A copy of another payload moved the status on; this one's late results are dropped.
			if (model.payloadCopy.key !== key && inner._tag !== "ClickedCopy") return { model }
			const current = model.payloadCopy.key === key ? model.payloadCopy.copy : CopyButton.init()
			const next = CopyButton.update(current, inner)
			return {
				model: { ...model, payloadCopy: { key, copy: next.model } },
				commands: Command.mapMessages(next.commands ?? [], (copy) =>
					Message.GotPayloadCopyMessage({ key, message: copy }),
				),
			}
		},
	})
