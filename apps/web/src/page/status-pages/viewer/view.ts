import { Option } from "effect"
import { pageTitle } from "@maple/status-page"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { StatusPagePublicSnapshot } from "@maple/domain/status-page"
import { linkButton } from "@maple/views/ui/button"
import { badge } from "@maple/views/ui/display"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { skeleton } from "@maple/views/ui/skeleton"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { statusPageHref, statusPagesHref } from "../shared/commands"
import { statusPageNotFound } from "../shared/not-found"
import { previewControls, previewDocument, previewFrame, simulateSnapshot } from "../shared/preview"
import { Message } from "./message"
import type { Model } from "./model"

type H = HtmlBuilder<Message>

const NOTE = {
	public: "Built from Maple's current data. Visitors read the published copy at its address.",
	password: "Built from Maple's current data. Visitors enter the page password to see it.",
	internal: "Only members of this organization can read this page.",
} as const

const EXAMPLE_NOTE = "Showing an example state. Visitors still see the live page."

/** The slim bar over the full-screen page: that it is a preview, its switches, the way back. */
const previewBar = (h: H, model: Model, snapshot: StatusPagePublicSnapshot, editorHref: string): Html =>
	hstack(
		h,
		{ gap: "3", align: "center", justify: "between", wrap: true, className: "border-b px-4 py-2" },
		[
			// One note at a time, so the bar stays one line: an example state outranks who can read it.
			hstack(h, { gap: "2", align: "center", className: "min-w-0 flex-1" }, [
				badge(h, { variant: "muted" }, ["Preview"]),
				typography(h, { size: "xs", tone: "muted", as: "p", className: "truncate" }, [
					model.previewState === "live" ? NOTE[snapshot.page.visibility] : EXAMPLE_NOTE,
				]),
			]),
			hstack(h, { gap: "2", align: "center", wrap: true }, [
				previewControls(h, {
					state: model.previewState,
					width: model.previewWidth,
					scheme: snapshot.page.theme.appearance === "auto" ? model.previewScheme : null,
					onState: (state) => Message.PickedPreviewState({ state }),
					onWidth: (width) => Message.PickedPreviewWidth({ width }),
					onScheme: (scheme) => Message.PickedPreviewScheme({ scheme }),
				}),
				linkButton(h, { size: "sm", variant: "outline", href: editorHref }, [
					icon(h, "XmarkIcon"),
					"Close preview",
				]),
			]),
		],
	)

/** The page fills the window over the shell (under its menus and toasts), as visitors see it. */
const fullScreen = (h: H, model: Model, snapshot: StatusPagePublicSnapshot, editorHref: string): Html =>
	vstack(h, { className: "fixed inset-0 z-45 overscroll-none bg-background" }, [
		previewBar(h, model, snapshot, editorHref),
		previewFrame(h, {
			title: pageTitle(snapshot.page.name),
			document: previewDocument({
				snapshot: simulateSnapshot(snapshot, model.previewState, model.previewScheme),
				nowMs: snapshot.generatedAt,
				isSelectable: false,
				publicUrl: null,
				opensLinks: true,
			}),
			opensLinks: true,
			width: model.previewWidth,
			className: "min-h-0 flex-1 rounded-none border-0",
		}),
	])

/** Loading, not found and failures stay in the dashboard; the loaded page goes full screen. */
const body = (h: H, model: Model): Html => {
	if (model.pageId === null) return dashboardPage(h, {}, [statusPageNotFound(h, model.rawPageId)])
	const data = model.snapshot.data
	if (AsyncData.isFailure(data))
		return dashboardPage(h, {}, [
			data.error.code === "status_page_not_found"
				? statusPageNotFound(h, model.rawPageId)
				: errorState(h, {
						failure: data.error,
						title: "Couldn't load the status page",
						onRetry: Message.ClickedRetry(),
						className: "py-12",
					}),
		])
	const editorHref = statusPageHref(model.pageId)
	return Option.match(AsyncData.getData(data), {
		onNone: () => dashboardPage(h, {}, [skeleton(h, "h-[640px] w-full")]),
		onSome: (snapshot) => fullScreen(h, model, snapshot, editorHref),
	})
}

export const breadcrumbsOf = (model: Model) => {
	const snapshot = Option.getOrUndefined(AsyncData.getData(model.snapshot.data))
	return [
		{ label: "Status pages", href: statusPagesHref() },
		...(snapshot === undefined || model.pageId === null
			? []
			: [{ label: snapshot.page.name, href: statusPageHref(model.pageId) }, { label: "Preview" }]),
	]
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, _inputs, h) => body(h, model))
