import { TONE_TEXT } from "@maple/ui/lib/tone"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription } from "../../../ui/alert"
import { button } from "../../../ui/button"
import { errorState } from "../../../ui/error-state"
import type { LoadFailure } from "../../../data/load-failure"
import { icon } from "../../../ui/icon"
import { pageTitle } from "../../../ui/page-layout"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { headerSummary } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { isDegraded, isLoadFailed, listedOf } from "./update"
import { listBody, listSkeleton } from "./view-list"

// The dashboards list page: `PageShell` around the list.

type H = HtmlBuilder<Message>

/** A disabled write control says why on hover: a disabled button gets no pointer events itself. */
const withReason = (h: H, reason: string | null, child: Html): Html =>
	reason === null ? child : h.span([h.Class("inline-flex cursor-not-allowed"), h.Title(reason)], [child])

// Browsers word a dropped connection differently; any of these means the write never reached Maple.
const UNREACHABLE = /failed to fetch|networkerror|load failed|network request failed/i

/** A failed write's cause: "Couldn't reach Maple" for a dropped connection, else the stored reason. */
const writeFailureCause = (error: string): string =>
	UNREACHABLE.test(error) ? "Couldn't reach Maple" : error.replace(/[.\s]+$/, "")

/** Said on the list's failure card and on the disabled buttons when both are down. */
const LIST_FAILED_READ_ONLY = "Creating and importing are off until Maple reconnects."

/** Why writes are off, or `null` while they are on. */
const readOnlyReason = (model: Model): string | null =>
	model.persistenceError === null && !isDegraded(model)
		? null
		: isLoadFailed(model)
			? LIST_FAILED_READ_ONLY
			: model.persistenceError === null
				? "Live sync is unavailable. Editing is off until it reconnects."
				: UNREACHABLE.test(model.persistenceError)
					? "Couldn't reach Maple. Editing is off until it reconnects."
					: `${writeFailureCause(model.persistenceError)}. Editing is off until it recovers.`

/** Browse templates, Import (the hidden file input) and Create dashboard. */
const actions = (h: H, reason: string | null): Html =>
	h.div(
		[h.Class("flex flex-wrap items-center gap-1")],
		[
			button(
				h,
				{ variant: "outline", size: "sm", attributes: [h.OnClick(Message.ClickedBrowseTemplates())] },
				[
					icon(h, "GridIcon", { attributes: [h.DataAttribute("icon", "inline-start")] }),
					"Browse templates",
				],
			),
			withReason(
				h,
				reason,
				button(
					h,
					{
						variant: "outline",
						size: "sm",
						isDisabled: reason !== null,
						attributes: [h.OnClick(Message.ClickedImport())],
					},
					[
						icon(h, "UploadIcon", { attributes: [h.DataAttribute("icon", "inline-start")] }),
						"Import",
					],
				),
			),
			withReason(
				h,
				reason,
				button(
					h,
					{
						size: "sm",
						isDisabled: reason !== null,
						attributes: [h.OnClick(Message.ClickedCreate())],
					},
					[
						icon(h, "PlusIcon", { attributes: [h.DataAttribute("icon", "inline-start")] }),
						"Create dashboard",
					],
				),
			),
			h.input([
				h.Accept(".json"),
				h.AriaLabel("Import dashboard JSON file"),
				h.Class("hidden"),
				h.Style({}),
				h.Type("file"),
				h.Id("dashboards-import-input"),
				h.OnFileChange((files) => Message.ChoseImportFile({ files })),
			]),
		],
	)

/** Pinned with the header: it explains the disabled buttons above it. When the list failed too,
 * its error state already explains the outage, so the banner is dropped. */
const persistenceBanner = (h: H, error: string | null, isListFailed: boolean): Html | undefined => {
	if (error === null || isListFailed) return undefined
	const cause = UNREACHABLE.test(error)
		? "Couldn't reach Maple, so editing, import and delete are off until it reconnects."
		: `${writeFailureCause(error)}. Editing, import and delete are off until it recovers.`
	return alert(h, { variant: "crit", size: "sm", className: "mb-3" }, [
		icon(h, "CircleWarningIcon", { size: 14 }),
		alertDescription(h, [`${cause} Your dashboards are safe and still readable.`], TONE_TEXT.crit),
	])
}

/** The sync stream and the HTTP fallback both failed (`ListLoadError`). */
const LIST_LOAD_FAILURE: LoadFailure = {
	_tag: "@maple/web/dashboards/ListLoadFailed",
	type: "api_error",
	code: "dashboards_list_unavailable",
	title: "Couldn't load dashboards",
	message: "Your dashboards are safe. Try again to reload the list.",
	retryable: false,
	recovery: "retry",
}

const listLoadError = (h: H, isReadOnly: boolean): Html =>
	errorState(h, {
		failure: LIST_LOAD_FAILURE,
		onRetry: Message.ClickedRetrySync(),
		note: isReadOnly ? LIST_FAILED_READ_ONLY : undefined,
		className: "min-h-64",
	})

/** `SyncDegradedBanner`: the rows are a frozen HTTP snapshot and writes are off. */
const degradedBanner = (h: H): Html =>
	h.div(
		[
			h.Class(
				"mb-3 flex items-start gap-2 rounded-md border border-border bg-surface-sunken p-2.5 text-xs text-muted-foreground",
			),
		],
		[
			icon(h, "CircleWarningIcon", { size: 14, className: "mt-0.5 shrink-0" }),
			h.span(
				[h.Class("flex-1")],
				[
					"Live sync is unavailable, so this is a snapshot loaded over HTTP. It won’t update on its own and editing is disabled.",
				],
			),
			button(
				h,
				{
					size: "xs",
					variant: "ghost",
					className: "-my-1 shrink-0 hover:text-foreground",
					attributes: [h.OnClick(Message.ClickedRetrySync())],
				},
				["Retry sync"],
			),
		],
	)

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const listed = listedOf(model)
	const isReady = listed !== null && model.nowMs !== null && model.isPrefsLoaded
	const summary =
		isReady && listed !== null && model.nowMs !== null
			? [
					h.div(
						[h.Class("text-muted-foreground mt-1 font-mono text-2xs")],
						[headerSummary(listed, model.nowMs, inputs.context.timeZone, model.locale)],
					),
				]
			: []
	const reason = readOnlyReason(model)
	const title = h.div([], [pageTitle(h, { className: "leading-8" }, ["Dashboards"]), ...summary])
	return dashboardPage(
		h,
		{
			titleContent: title,
			actions: actions(h, reason),
			sticky: persistenceBanner(h, model.persistenceError, isLoadFailed(model)),
		},
		isLoadFailed(model)
			? [listLoadError(h, reason !== null)]
			: [
					...(isDegraded(model) ? [degradedBanner(h)] : []),
					isReady && listed !== null && model.nowMs !== null
						? listBody(h, model, listed, model.nowMs, inputs.context.timeZone)
						: listSkeleton(h),
				],
	)
})
