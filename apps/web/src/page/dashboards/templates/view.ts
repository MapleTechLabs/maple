import { AsyncData, Submodel } from "foldkit"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { WIDGET_CHART_TOKENS } from "../kit/chart-tokens"
import { ResolveThemeColors } from "../../../charts/theme-colors"
import { button } from "../../../ui/button"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { icon } from "../../../ui/icon"
import { refreshButton } from "../../../ui/refresh-button"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { BLANK_TEMPLATE_ID, computeReadiness } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { PANEL_SHEET_ID, selectedOf, templatesOf } from "./update"
import * as DialogView from "../../../ui/dialog-view"
import { templateList } from "./view-list"
import { detailPanel, panelRestState } from "./view-panel"

// The templates page: below `lg` the detail panel is a
// right sheet over the list (`panelIsSheet`), else the side pane.

type H = HtmlBuilder<Message>

const summary = (h: H, readyCount: number, catalogueCount: number): Html =>
	h.div(
		[h.Class("flex items-center gap-2 text-xs")],
		[
			h.span([h.Class("text-primary font-mono")], [String(readyCount), " ready for your data"]),
			h.span([h.Class("text-muted-foreground")], ["·"]),
			h.span([h.Class("text-muted-foreground font-mono")], [String(catalogueCount), " templates"]),
		],
	)

const failed = (h: H, model: Model): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "CircleWarningIcon", { size: 18 })]),
				emptyTitle(h, ["Couldn't load the templates"]),
				emptyDescription(h, [
					"The template catalogue didn't answer. Nothing you've built is affected — this page only reads.",
				]),
			]),
			h.div(
				[h.Class("flex items-center gap-2")],
				[
					refreshButton(h, {
						onRefresh: Message.ClickedRetry(),
						isPending: AsyncData.isLoading(model.templates.data),
						variant: "default",
						size: "sm",
						label: "Try again",
					}),
					button(
						h,
						{
							variant: "outline",
							size: "sm",
							attributes: [h.OnClick(Message.ClickedCreate({ templateId: BLANK_TEMPLATE_ID }))],
						},
						["Start blank instead"],
					),
				],
			),
		],
		"h-full",
	)

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const templates = templatesOf(model)
	const metrics = Option.getOrNull(AsyncData.getData(model.metrics.data))
	const readiness = computeReadiness(templates, metrics)
	const listed = templates.filter((template) => template.id !== BLANK_TEMPLATE_ID)
	const readyCount = listed.filter((template) => readiness.get(template.id)?.ready !== false).length
	const isLoaded = AsyncData.isSuccess(model.templates.data) || AsyncData.isRefreshing(model.templates.data)
	const isFailed = AsyncData.isFailure(model.templates.data)
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
					titleContent:
						isLoaded && metrics !== null ? summary(h, readyCount, listed.length) : undefined,
					actions: button(
						h,
						{ variant: "outline", size: "sm", attributes: [h.OnClick(Message.ClickedBack())] },
						[
							icon(h, "ArrowLeftIcon", {
								attributes: [h.DataAttribute("icon", "inline-start")],
							}),
							"Back to dashboards",
						],
					),
					fill: true,
				},
				[
					isFailed
						? failed(h, model)
						: h.div(
								[h.Class("flex h-full min-h-0")],
								[
									h.div(
										[
											h.Class(
												"flex min-h-0 w-full flex-col border-border lg:w-[460px] lg:shrink-0 lg:border-r",
											),
										],
										[templateList(h, model, readiness)],
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
								],
							),
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
