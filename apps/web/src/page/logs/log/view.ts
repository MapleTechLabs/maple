import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { BreadcrumbEntry } from "../../../shell"
import { linkButton } from "../../../ui/button"
import { errorState } from "../../../ui/error-state"
import { heading } from "../../../ui/heading"
import { icon } from "../../../ui/icon"
import { keyValue, keyValueList } from "../../../ui/key-value"
import { skeleton } from "../../../ui/skeleton"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
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

/** A link that leads nowhere, drawn like the load failure: a dashed card at the top, same type scale. */
const missingState = (h: H, options: Readonly<{ title: string; description: string; detail?: Html }>): Html =>
	h.div(
		[
			h.Role("status"),
			h.Class(
				"flex flex-col items-center justify-center gap-4 rounded-md border border-dashed px-6 py-8 text-center",
			),
		],
		[
			h.div(
				[h.AriaHidden(true), h.Class("rounded-md border bg-surface-faint p-2.5 text-muted-foreground")],
				[icon(h, "CircleWarningIcon", { size: 18 })],
			),
			h.div(
				[h.Class("max-w-md space-y-1")],
				[
					heading(h, { level: 2, variant: "subsection", className: "font-prose" }, [options.title]),
					h.p(
						[h.Class("font-prose text-ui text-balance text-muted-foreground")],
						[options.description],
					),
				],
			),
			...(options.detail === undefined ? [] : [options.detail]),
			linkButton(h, { variant: "outline", size: "sm", href: BACK.href }, [BACK.label]),
		],
	)

const notFound = (h: H, key: NonNullable<Model["key"]>): Html =>
	missingState(h, {
		title: "Log not found",
		description: "This log could not be found. It may have aged out of retention.",
		detail: keyValueList(h, { layout: "grid", className: "text-sm" }, [
			keyValue(h, { label: "Service", mono: true }, [key.serviceName]),
			keyValue(h, { label: "Timestamp", mono: true }, [key.timestamp]),
		]),
	})

const body = (h: H, model: Model, timeZone: string): ReadonlyArray<Html> => {
	const { key } = model
	if (key === null)
		return [
			missingState(h, {
				title: "Invalid link",
				description: "This log link could not be read. Check that it was copied in full.",
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
/** A link that resolves to no log keeps the page's title, as a load failure does. */
const isMissing = (model: Model): boolean =>
	model.key === null || Option.getOrUndefined(AsyncData.getData(model.log.data)) === null

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	dashboardPage(
		h,
		isMissing(model) ? { title: "Logs", gap: "sm" } : { gap: "sm" },
		body(h, model, inputs.context.timeZone),
	),
)

export const breadcrumbsOf = (model: Model): ReadonlyArray<BreadcrumbEntry> => [
	{ label: "Logs", href: "/logs" },
	{
		label:
			model.key === null
				? "Invalid link"
				: AsyncData.matchData(model.log.data, {
						onEmpty: () => "Loading…",
						onFailure: () => "Error",
						onData: (log) => (log === null ? "Not found" : bodyExcerpt(log.body)),
					}),
	},
]
