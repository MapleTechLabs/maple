import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { BreadcrumbEntry } from "../../../shell"
import { errorState } from "../../../ui/error-state"
import { keyValue, keyValueList } from "../../../ui/key-value"
import { skeleton } from "../../../ui/skeleton"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { resourceNotFound } from "../../kit/resource-not-found"
import * as LogDetail from "../detail"
import { Message, type Model } from "./model"

type H = HtmlBuilder<Message>

const BACK = { href: "/logs", label: "Back to Logs" }

const bodyExcerpt = (body: string): string => {
	const trimmed = body.trim()
	return trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed || "Log"
}

const loading = (h: H): ReadonlyArray<Html> => [
	skeleton(h, "h-24 w-full rounded-md"),
	h.div(
		[h.Class("grid gap-3 lg:grid-cols-[1fr_minmax(360px,440px)]")],
		[skeleton(h, "h-64 w-full rounded-md"), skeleton(h, "h-64 w-full rounded-md")],
	),
]

const notFound = (h: H, key: NonNullable<Model["key"]>): Html =>
	resourceNotFound(h, {
		title: "Log not found",
		description: [
			h.div(
				[h.Class("flex flex-col items-center gap-4")],
				[
					h.p([], ["This log could not be found. It may have aged out of retention."]),
					keyValueList(h, { layout: "grid", className: "text-sm" }, [
						keyValue(h, { label: "Service", mono: true }, [key.serviceName]),
						keyValue(h, { label: "Timestamp", mono: true }, [key.timestamp]),
					]),
				],
			),
		],
		back: BACK,
	})

const body = (h: H, model: Model, timeZone: string): ReadonlyArray<Html> => {
	const { key } = model
	if (key === null)
		return [
			resourceNotFound(h, {
				title: "Log not found",
				description: "The link could not be decoded. Check that it was copied in full.",
				back: BACK,
			}),
		]
	return AsyncData.matchData(model.log.data, {
		onEmpty: () => loading(h),
		onFailure: (failure) => [
			errorState(h, { failure, title: "Couldn't load log", onRetry: Message.ClickedRetry() }),
		],
		onData: (log) =>
			log === null
				? [notFound(h, key)]
				: [
						h.submodel({
							slotId: "log-page-panels",
							model: model.detail,
							view: LogDetail.pageView,
							viewInputs: { timeZone },
							toParentMessage: (message) => Message.GotDetailMessage({ message }),
						}),
					],
	})
}

/** `LogDetailPage` over `ResultPage` (`gap="sm"`). */
export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	dashboardPage(h, { gap: "sm" }, body(h, model, inputs.context.timeZone)),
)

export const breadcrumbsOf = (model: Model): ReadonlyArray<BreadcrumbEntry> => [
	{ label: "Logs", href: "/logs" },
	{
		label:
			model.key === null
				? "Not found"
				: AsyncData.matchData(model.log.data, {
						onEmpty: () => "Loading…",
						onFailure: () => "Error",
						onData: (log) => (log === null ? "Not found" : bodyExcerpt(log.body)),
					}),
	},
]
