import { TONE_TEXT } from "@maple/ui/lib/tone"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription } from "../../../ui/alert"
import { button } from "../../../ui/button"
import { icon } from "../../../ui/icon"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { headerSummary } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { listBody, listSkeleton } from "./view-list"

// `DashboardListPage` (apps/web/src/routes/dashboards/index.tsx): `PageShell` around the list.

type H = HtmlBuilder<Message>

/** Browse templates, Import (the hidden file input) and Create dashboard. */
const actions = (h: H, isReadOnly: boolean): Html =>
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
			button(
				h,
				{
					variant: "outline",
					size: "sm",
					isDisabled: isReadOnly,
					attributes: [h.OnClick(Message.ClickedImport())],
				},
				[icon(h, "UploadIcon", { attributes: [h.DataAttribute("icon", "inline-start")] }), "Import"],
			),
			button(
				h,
				{ size: "sm", isDisabled: isReadOnly, attributes: [h.OnClick(Message.ClickedCreate())] },
				[
					icon(h, "PlusIcon", { attributes: [h.DataAttribute("icon", "inline-start")] }),
					"Create dashboard",
				],
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

/** Pinned with the header: it explains the disabled buttons above it. */
const persistenceBanner = (h: H, error: string | null): Html | undefined =>
	error === null
		? undefined
		: alert(h, { variant: "crit", size: "sm", className: "mb-3" }, [
				icon(h, "CircleWarningIcon", { size: 14 }),
				alertDescription(
					h,
					[
						error,
						". Editing, import and delete are disabled until it recovers; reading is unaffected.",
					],
					TONE_TEXT.crit,
				),
			])

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const isReady = model.dashboards !== null && model.nowMs !== null && model.isPrefsLoaded
	const summary =
		isReady && model.dashboards !== null && model.nowMs !== null
			? h.div(
					[h.Class("text-muted-foreground mt-1 font-mono text-2xs")],
					[headerSummary(model.dashboards, model.nowMs, inputs.context.timeZone, model.locale)],
				)
			: undefined
	const isReadOnly = model.persistenceError !== null
	return dashboardPage(
		h,
		{
			titleContent: summary,
			actions: actions(h, isReadOnly),
			sticky: persistenceBanner(h, model.persistenceError),
		},
		[
			isReady && model.dashboards !== null && model.nowMs !== null
				? listBody(h, model, model.dashboards, model.nowMs, inputs.context.timeZone)
				: listSkeleton(h),
		],
	)
})
