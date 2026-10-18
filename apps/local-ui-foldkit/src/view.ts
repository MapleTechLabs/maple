import { sidebarInset, sidebarTrigger, sidebarWrapper } from "@maple/web-foldkit/ui/sidebar"
import * as ToastView from "@maple/web-foldkit/ui/toast-view"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Document, Html, HtmlBuilder } from "foldkit/html"
import { presenceOf } from "./data/signal-presence"
import { Message } from "./message"
import type { Model } from "./model"
import { rangeOf } from "./page/contract"
import { viewPage } from "./page/registry"
import { queryOf } from "./route"
import { connectionOf } from "./server/derive"
import { disconnectedState, rejectedState } from "./shell/connection-states"
import { shownDataOf } from "./data/shown"
import { describeNotice, staleNotice } from "./shell/stale-notice"
import { localLockup } from "./shell/lockup"
import { appSidebar } from "./shell/sidebar"
import { pageContextOf } from "./update-page"

// apps/local-ui/src/App.tsx.

/** Section links carry the cross-cutting context: the service filter and the range. */
const sectionQuery = (model: Model): URLSearchParams => {
	const context = pageContextOf(model)
	const next = new URLSearchParams({ range: rangeOf(context) })
	const service = queryOf(model.location).get("service")
	if (service) next.set("service", service)
	return next
}

const pageView = (h: HtmlBuilder<Message>, model: Model): Html => {
	const presence = AsyncData.getData(model.presence)
	const lastIngest = Option.flatMap(model.maybeServer, (server) => Option.fromNullishOr(server.lastIngestAtMs))
	return viewPage(
		h,
		model.page,
		{
			context: pageContextOf(model),
			presenceOf: (signal) => presenceOf(presence, signal),
			presenceNowMs: Option.match(presence, { onNone: () => 0, onSome: (result) => result.nowMs }),
			hasNewDataSince: (sinceMs) => sinceMs > 0 && Option.exists(lastIngest, (last) => last > sinceMs),
		},
		(message) => Message.GotPageMessage({ message }),
	)
}

/**
 * Only a server that is really gone (or refusing this page) swaps the views out. A gone server
 * with saved results keeps them, and the notice says what they are.
 */
const mainContent = (h: HtmlBuilder<Message>, model: Model): ReadonlyArray<Html> => {
	const connection = connectionOf(model.maybeServer)
	const isDisconnected = connection.status === "disconnected"
	if (isDisconnected && !model.hasCache) return [disconnectedState(h, model)]
	if (connection.status === "rejected" && connection.rejection !== null) return [rejectedState(h, connection.rejection)]
	if (connection.status === "rejected") return [pageView(h, model)]
	const nowMs = Option.match(model.maybeServer, { onNone: () => 0, onSome: (server) => server.checkedAtMs })
	const notice = describeNotice({
		isDisconnected,
		isBusy: Option.exists(model.maybeServer, (server) => server.reachability === "busy"),
		shown: shownDataOf(model.page, nowMs),
		nowMs,
		timeFormat: model.timeFormat,
	})
	return [pageView(h, model), ...(notice === null ? [] : [staleNotice(h, notice, Message.ClickedRetryStaleData())])]
}

// NOTE: Foldkit's first render replaces the container, so the view root is `div#app` itself.
// The toast regions go first: their Mount moves them to <body>.
export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
	title: "Maple Local",
	body: h.div(
		[h.Id("app")],
		[
			...ToastView.regions(h, model.toasts, (message) => Message.GotToastMessage({ message })),
			sidebarWrapper(
				h,
				[
					appSidebar(h, model, sectionQuery(model)),
					sidebarInset(
						h,
						[
							h.header(
								[h.Class("flex h-12 shrink-0 items-center gap-2 border-b px-4 md:hidden")],
								[
									sidebarTrigger(h, {
										state: model.isSidebarOpen ? "expanded" : "collapsed",
										className: "-ml-1",
										attributes: [h.OnClick(Message.ClickedToggleSidebar())],
									}),
									localLockup(h),
								],
							),
							h.div([h.Class("relative min-h-0 flex-1")], mainContent(h, model)),
						],
						"h-dvh text-foreground",
					),
				],
				[],
				"min-h-dvh",
			),
		],
	),
})
