import { AsyncData, Submodel } from "foldkit"
import { Option, Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { WIDGET_CHART_TOKENS } from "../kit/chart-tokens"
import { ResolveThemeColors } from "@maple/views/charts/theme-colors"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { errorState } from "@maple/views/ui/error-state"
import { pageTitle } from "@maple/views/ui/page-layout"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { BLANK_TEMPLATE_ID, computeReadiness } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { PANEL_SHEET_ID, selectedOf, templatesOf } from "./update"
import * as DialogView from "@maple/views/ui/dialog-view"
import { templateList } from "./view-list"
import { detailPanel, panelRestState } from "./view-panel"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"

// The templates page: below `lg` the detail panel is a
// right sheet over the list (`panelIsSheet`), else the side pane.

type H = HtmlBuilder<Message>

const summary = (h: H, readyCount: number, catalogueCount: number): Html =>
	hstack(h, { gap: "2", align: "center", className: "text-xs" }, [
		typography(h, { tone: "primary", mono: true }, [String(readyCount), " ready for your data"]),
		typography(h, { tone: "muted" }, ["·"]),
		typography(h, { tone: "muted", mono: true }, [String(catalogueCount), " templates"]),
	])

const failed = (h: H, failure: LoadFailure): Html =>
	h.div(
		[h.Class("p-4")],
		[
			errorState(h, {
				failure,
				title: "Couldn't load the templates",
				note: "Nothing you've built is affected.",
				onRetry: Message.ClickedRetry(),
				secondaryAction: {
					label: "Start blank instead",
					onClick: Message.ClickedCreate({ templateId: BLANK_TEMPLATE_ID }),
				},
			}),
		],
	)

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const templates = templatesOf(model)
	const metrics = Option.getOrNull(AsyncData.getData(model.metrics.data))
	const readiness = computeReadiness(templates, metrics)
	const listed = Arr.filter(templates, (template) => template.id !== BLANK_TEMPLATE_ID)
	const readyCount = Arr.filter(listed, (template) => readiness.get(template.id)?.ready !== false).length
	const isLoaded = AsyncData.isSuccess(model.templates.data) || AsyncData.isRefreshing(model.templates.data)
	const failure = model.templates.data._tag === "Failure" ? model.templates.data.error : null
	const selected = selectedOf(model)
	const isSheet = inputs.isBelowLg === true
	const panel = (template: NonNullable<typeof selected>) =>
		detailPanel(
			h,
			model,
			template,
			metrics === null ? undefined : readiness.get(template.id),
			inputs.context.timeZone,
		)
	return h.div(
		[h.Class("contents"), h.OnMount(ResolveThemeColors({ tokens: WIDGET_CHART_TOKENS }))],
		[
			dashboardPage(
				h,
				{
					titleContent: vstack(h, { gap: "1" }, [
						pageTitle(h, { className: "leading-8" }, ["Templates"]),
						...(isLoaded && metrics !== null ? [summary(h, readyCount, listed.length)] : []),
					]),
					fill: true,
				},
				[
					failure !== null
						? failed(h, failure)
						: hstack(h, { align: "stretch", className: "h-full min-h-0" }, [
								vstack(
									h,
									{
										className:
											"min-h-0 w-full border-border lg:w-[500px] lg:shrink-0 lg:border-r",
									},
									[templateList(h, model, readiness, metrics !== null)],
								),
								...(isSheet
									? []
									: [
											h.div(
												[
													h.Class(
														"bg-background min-w-0 grow overflow-y-auto [--panel-surface:var(--background)]",
													),
												],
												[selected === null ? panelRestState(h) : panel(selected)],
											),
										]),
							]),
				],
			),
			...(isSheet && selected !== null ? [panelSheet(h, model, panel(selected))] : []),
		],
	)
})

/** `<SheetContent side="right">` with the sr-only header, around the detail panel. */
const panelSheet = (h: H, model: Model, content: Html): Html =>
	h.submodel({
		slotId: `${PANEL_SHEET_ID}-dialog`,
		model: model.panelSheet,
		view: DialogView.view,
		viewInputs: {
			className: "w-full overflow-y-auto p-0 [--panel-surface:var(--popover)] sm:max-w-lg",
			side: "right",
			hasTrigger: false,
			toView: ({ portal }) => portal,
			toContent: () => [
				DialogView.dialogHeader(
					h,
					"sheet",
					[
						DialogView.dialogTitle(
							h,
							"sheet",
							PANEL_SHEET_ID,
							selectedOf(model)?.name ?? "Template",
						),
						DialogView.dialogDescription(
							h,
							"sheet",
							PANEL_SHEET_ID,
							"What this template builds and what it needs.",
						),
					],
					"sr-only",
				),
				content,
			],
		},
		toParentMessage: (message) => Message.GotPanelSheetMessage({ message }),
	})
