import { AsyncData, Submodel } from "foldkit"
import type { Html } from "foldkit/html"
import { failureMessage } from "../../../data/load-failure"
import { alert, alertDescription, alertTitle } from "../../../ui/alert"
import { button, linkButton } from "../../../ui/button"
import { errorState } from "../../../ui/error-state"
import { icon } from "../../../ui/icon"
import { input } from "../../../ui/input"
import { label } from "../../../ui/label"
import { skeleton } from "../../../ui/skeleton"
import { switchControl } from "../../../ui/switch"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { draftProblems } from "./form"
import { ingestionHref } from "./hrefs"
import { Message } from "./message"
import type { Model } from "./model"
import { actionClause } from "./view-action"
import { conditionsClause, type H, signalsClause } from "./view-form"
import { previewPanel } from "./view-preview"

// `/settings/ingestion/rules/new` and `/:id`: the sentence form, its preview and the action bar.

const nameRow = (h: H, model: Model): Html =>
	h.div(
		[h.Class("flex flex-wrap items-end gap-4")],
		[
			h.div(
				[h.Class("flex min-w-0 flex-1 flex-col gap-1.5")],
				[
					label(h, { attributes: [h.For("ingest-rule-name")] }, ["Name"]),
					input(h, {
						id: "ingest-rule-name",
						attributes: [
							h.Value(model.draft.name),
							h.Placeholder("Drop debug logs"),
							h.OnInput((value) => Message.ChangedText({ part: "name", value })),
						],
					}),
				],
			),
			h.label(
				[h.Class("flex h-9 items-center gap-2 text-sm")],
				[
					...switchControl(h, {
						id: "ingest-rule-enabled",
						inputId: "ingest-rule-enabled-input",
						isChecked: model.draft.enabled,
						ariaLabel: "Enabled",
						onToggle: Message.ToggledEnabled(),
					}),
					"Enabled",
				],
			),
		],
	)

const problemsList = (h: H, problems: ReadonlyArray<string>): Html =>
	problems.length === 0
		? h.span(
				[h.Class("text-severity-info flex items-center gap-1.5 text-xs")],
				[icon(h, "CheckIcon", { size: 14 }), "Ready to save"],
			)
		: h.div(
				[h.Class("text-muted-foreground flex min-w-0 items-start gap-1.5 text-xs")],
				[
					icon(h, "CircleWarningIcon", {
						size: 14,
						className: "text-severity-warn mt-px shrink-0",
					}),
					h.div(
						[],
						[
							h.span([], ["Fix before saving:"]),
							h.ul(
								[h.AriaLabel("Fix before saving")],
								problems.map((problem) =>
									h.li([h.Key(problem), h.Class("text-foreground")], [problem]),
								),
							),
						],
					),
				],
			)

const actionBar = (h: H, model: Model): Html => {
	const problems = draftProblems(model.draft)
	return h.div(
		[h.Class("bg-background/95 sticky bottom-0 z-20 -mx-4 -mb-4 mt-2 border-t px-4 py-3 backdrop-blur")],
		[
			...(model.saveFailure === null
				? []
				: [
						alert(h, { variant: "crit", size: "sm", className: "mb-3" }, [
							icon(h, "CircleXmarkIcon"),
							alertTitle(h, ["Couldn't save the rule"]),
							alertDescription(h, [failureMessage(model.saveFailure)]),
						]),
					]),
			h.div(
				[h.Class("flex items-center justify-between gap-4")],
				[
					problemsList(h, problems),
					h.div(
						[h.Class("flex shrink-0 items-center gap-2")],
						[
							linkButton(h, { variant: "outline", href: ingestionHref() }, ["Cancel"]),
							button(
								h,
								{
									isDisabled: problems.length > 0 || !model.isAdmin,
									isLoading: model.isSaving,
									attributes: [h.OnClick(Message.ClickedSave())],
								},
								[model.editingId === null ? "Create rule" : "Save changes"],
							),
						],
					),
				],
			),
		],
	)
}

const backLink = (h: H) =>
	h.div([], [linkButton(h, { variant: "outline", href: ingestionHref() }, ["Back to ingestion"])])

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, _inputs, h) => {
	const header = {
		title: model.editingId === null && !model.isBadId ? "New ingest rule" : "Edit ingest rule",
		description: "Drop or redact telemetry before Maple stores or bills it.",
	}
	if (model.isSessionLoaded && !model.isAdmin)
		return dashboardPage(h, header, [
			alert(h, { variant: "info" }, [
				icon(h, "ShieldIcon"),
				alertTitle(h, ["Only org admins can create or change ingest rules"]),
				alertDescription(h, ["Ask an admin to make this change."]),
			]),
			backLink(h),
		])
	if (model.isBadId)
		return dashboardPage(h, header, [
			alert(h, { variant: "warn" }, [
				icon(h, "CircleWarningIcon"),
				alertTitle(h, ["This rule does not exist"]),
			]),
			backLink(h),
		])
	if (AsyncData.isFailure(model.existing))
		return dashboardPage(h, header, [
			errorState(h, { failure: model.existing.error, title: "Couldn't load the rule" }),
			backLink(h),
		])
	if (model.editingId !== null && !AsyncData.isSuccess(model.existing))
		return dashboardPage(h, header, [skeleton(h, "h-10 w-full"), skeleton(h, "h-80 w-full")])
	return dashboardPage(h, { ...header, gap: "lg" }, [
		h.div(
			[h.Class("grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]")],
			[
				h.div(
					[h.Class("flex min-w-0 flex-col gap-5")],
					[
						nameRow(h, model),
						signalsClause(h, model),
						conditionsClause(h, model),
						actionClause(h, model),
					],
				),
				h.div([h.Class("lg:sticky lg:top-4 lg:self-start")], [previewPanel(h, model)]),
			],
		),
		actionBar(h, model),
	])
})
