import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { errorState } from "@maple/views/ui/error-state"
import { skeleton } from "@maple/views/ui/skeleton"
import { typography } from "@maple/views/ui/typography"
import { vstack } from "@maple/views/ui/stack"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { statusPageHref, statusPagesHref } from "../shared/commands"
import { statusPageNotFound } from "../shared/not-found"
import { previewDocument, previewFrame } from "../shared/preview"
import { Message } from "./message"
import type { Model } from "./model"

type H = HtmlBuilder<Message>

const NOTE = {
	public: "Built from Maple's current data. Visitors read the published copy at its address.",
	password: "Built from Maple's current data. Visitors enter the page password to see it.",
	internal: "Only members of this organization can read this page.",
} as const

const body = (h: H, model: Model): Html => {
	if (model.pageId === null) return statusPageNotFound(h, model.rawPageId)
	const data = model.snapshot.data
	if (AsyncData.isFailure(data))
		return data.error.code === "status_page_not_found"
			? statusPageNotFound(h, model.rawPageId)
			: errorState(h, {
					failure: data.error,
					title: "Couldn't load the status page",
					onRetry: Message.ClickedRetry(),
					className: "py-12",
				})
	return Option.match(AsyncData.getData(data), {
		onNone: () => skeleton(h, "h-[640px] w-full"),
		onSome: (snapshot) =>
			vstack(h, { gap: "2" }, [
				typography(h, { size: "xs", tone: "muted", as: "p" }, [NOTE[snapshot.page.visibility]]),
				previewFrame(h, {
					title: `${snapshot.page.name} status`,
					document: previewDocument({
						snapshot,
						nowMs: snapshot.generatedAt,
						isSelectable: false,
						selectedIds: [],
						publicUrl: null,
						opensLinks: true,
					}),
					opensLinks: true,
					className: "h-[640px] lg:h-[calc(100vh-12rem)] lg:min-h-[520px]",
				}),
			]),
	})
}

export const breadcrumbsOf = (model: Model) => {
	const snapshot = Option.getOrUndefined(AsyncData.getData(model.snapshot.data))
	return [
		{ label: "Status pages", href: statusPagesHref() },
		...(snapshot === undefined || model.pageId === null
			? []
			: [{ label: snapshot.page.name, href: statusPageHref(model.pageId) }, { label: "View" }]),
	]
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, _inputs, h) =>
	dashboardPage(h, {}, [body(h, model)]),
)
