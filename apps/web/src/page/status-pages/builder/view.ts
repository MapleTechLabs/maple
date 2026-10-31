import { StatusPageComponentId, StatusPageId } from "@maple/domain"
import { DEFAULT_STATUS_PAGE_THEME, StatusPageSlug } from "@maple/domain/status-page"
import { previewSnapshot } from "@maple/status-page"
import { Schema } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { failureMessage } from "../../../data/load-failure"
import { alert, alertDescription, alertTitle } from "../../../ui/alert"
import { button, linkButton } from "../../../ui/button"
import { errorState } from "../../../ui/error-state"
import { icon } from "../../../ui/icon"
import { segmentedSelect } from "../../../ui/segmented-select"
import { skeleton } from "../../../ui/skeleton"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { resourceNotFound } from "../../kit/resource-not-found"
import { settingsSection } from "../../settings/kit/section"
import { publicAddress, statusPagesHref } from "../shared/commands"
import { textField } from "../shared/fields"
import { APPEARANCES, presetCards } from "../shared/look"
import { checkedRows } from "../shared/picker"
import { pickerView } from "../shared/picker-view"
import { daysOf, previewDocument, previewFrame, previewTheme } from "../shared/preview"
import { FocusNewRow } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { canSubmit, monitorsOf, NAME_ID, nameIssue, PICKER_ID, SLUG_ID, slugError } from "./update"

// `/status-pages/new`: the form on the left, the page as visitors get it on the right, and the
// publish bar under both. Below 1000px the preview stacks under the form.

type H = HtmlBuilder<Message>

const isSlug = Schema.is(StatusPageSlug)
const DRAFT_PAGE_ID = Schema.decodeSync(StatusPageId)("00000000-0000-4000-8000-000000000000")
const draftComponentId = (index: number) =>
	Schema.decodeSync(StatusPageComponentId)(`00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`)

const pageSection = (h: H, model: Model): Html =>
	settingsSection(h, { id: "status-page-builder-page", title: "Page" }, [
		h.div(
			[h.Class("flex flex-col gap-4")],
			[
				textField(h, {
					id: NAME_ID,
					label: "Name",
					value: model.name,
					placeholder: "Acme Status",
					error: nameIssue(model),
					onInput: (value) => Message.ChangedName({ value }),
					onBlur: Message.BlurredName(),
				}),
				textField(h, {
					id: SLUG_ID,
					label: "Address",
					value: model.slug,
					placeholder: "acme-status",
					isMono: true,
					hint:
						model.slug === ""
							? "Follows the name until you type one."
							: publicAddress(model.slug),
					error: slugError(model),
					onInput: (value) => Message.ChangedSlug({ value }),
				}),
			],
		),
	])

const componentsBody = (h: H, model: Model): Html => {
	const data = model.monitors.data
	if (AsyncData.isFailure(data))
		return errorState(h, {
			failure: data.error,
			title: "Couldn't load your monitors",
			onRetry: Message.ClickedRetry(),
			className: "rounded-md border py-8",
		})
	if (!model.isSeeded)
		return h.div(
			[h.Class("flex flex-col gap-2"), h.AriaBusy(true)],
			[skeleton(h, "h-12 w-full"), skeleton(h, "h-12 w-full"), skeleton(h, "h-12 w-full")],
		)
	return pickerView(h, {
		picker: model.picker,
		monitors: monitorsOf(model),
		toMessage: (message) => Message.GotPickerMessage({ message }),
		idPrefix: PICKER_ID,
		isDisabled: model.submitting !== null,
		focusOnMount: h.OnMount(FocusNewRow()),
	})
}

const componentsSection = (h: H, model: Model): Html => {
	const count = checkedRows(model.picker).length
	return settingsSection(
		h,
		{
			id: "status-page-builder-components",
			title: "What's on it",
			description: [
				count === 0
					? "Each component shows its status and uptime. Monitored ones follow their monitor."
					: `${count} ${count === 1 ? "component" : "components"}. Monitored ones follow their monitor; rename or group them as visitors should read them.`,
			],
		},
		[componentsBody(h, model)],
	)
}

const lookSection = (h: H, model: Model): Html =>
	settingsSection(
		h,
		{
			id: "status-page-builder-look",
			title: "Look",
			description: ["Logo, colors, fonts and links later, in Settings."],
		},
		[
			h.div(
				[h.Class("flex flex-col gap-4")],
				[
					presetCards(h, {
						selected: model.preset,
						isDisabled: model.submitting !== null,
						onPick: (preset) => Message.PickedPreset({ preset }),
					}),
					h.div(
						[h.Class("flex flex-wrap items-center gap-3")],
						[
							h.span([h.Class("text-xs text-muted-foreground")], ["Mode"]),
							segmentedSelect(h, {
								size: "sm",
								ariaLabel: "Mode",
								value: model.appearance,
								onChange: (appearance) => Message.PickedAppearance({ appearance }),
								options: APPEARANCES,
							}),
							h.span(
								[h.Class("text-xs text-muted-foreground")],
								[
									model.appearance === "auto"
										? "Follows each visitor's setting."
										: `Every visitor sees it ${model.appearance}.`,
								],
							),
						],
					),
				],
			),
		],
	)

/** The draft as the public renderer draws it, with the monitors' history from the last preview. */
const draftDocument = (model: Model): string => {
	const nowMs = model.nowMs ?? 0
	const monitors = monitorsOf(model)
	const snapshot = previewSnapshot({
		pageId: DRAFT_PAGE_ID,
		page: {
			name: model.name.trim() === "" ? "Status page" : model.name.trim(),
			slug: isSlug(model.slug) ? model.slug : "preview",
			description: null,
			websiteUrl: null,
			logoUrl: null,
			privacyUrl: null,
			termsUrl: null,
			showPoweredBy: true,
			theme: previewTheme(
				{ ...DEFAULT_STATUS_PAGE_THEME, preset: model.preset, appearance: model.appearance },
				model.previewScheme,
			),
		},
		components: checkedRows(model.picker).map((row, index) => ({
			id: draftComponentId(index),
			name: row.name.trim() === "" ? "Untitled component" : row.name.trim(),
			description: null,
			group: row.group.trim() === "" ? null : row.group.trim(),
			monitorStatus: monitors.find((monitor) => monitor.id === row.monitorId)?.state.status ?? null,
			manualStatus: row.monitorId === null ? row.manualStatus : null,
			showUptime: true,
			monitored: row.monitorId !== null,
			days: daysOf(model.previewHistory, row.monitorId),
		})),
		incidents: [],
		nowMs,
	})
	return previewDocument({ snapshot, nowMs, isSelectable: false, selectedIds: [] })
}

const previewPanel = (h: H, model: Model): Html =>
	h.section(
		[
			h.AriaLabelledBy("status-page-builder-preview"),
			// The same clearance as the form column, so the publish bar never covers the frame.
			h.Class("flex min-w-0 flex-col gap-3 pb-16 min-[1000px]:sticky min-[1000px]:top-0"),
		],
		[
			h.div(
				[h.Class("flex min-h-7 items-center justify-between gap-3")],
				[
					h.div(
						[h.Class("flex items-center gap-2")],
						[
							h.h2(
								[h.Id("status-page-builder-preview"), h.Class("text-sm font-medium")],
								["Preview"],
							),
							h.span(
								[h.Class("font-mono text-xs text-muted-foreground"), h.AriaLive("polite")],
								[model.isPreviewLoading ? "Updating" : ""],
							),
						],
					),
					...(model.appearance === "auto"
						? [
								segmentedSelect(h, {
									size: "xs",
									ariaLabel: "Preview mode",
									value: model.previewScheme,
									onChange: (scheme) => Message.PickedPreviewScheme({ scheme }),
									options: [
										{ value: "light", label: "Light" },
										{ value: "dark", label: "Dark" },
									],
								}),
							]
						: []),
				],
			),
			previewFrame(h, {
				title: "Status page preview",
				document: draftDocument(model),
				className: "h-[560px] min-[1000px]:h-[calc(100vh-20rem)] min-[1000px]:min-h-[520px]",
			}),
			model.previewFailure === null
				? h.p(
						[h.Class("text-xs text-muted-foreground")],
						["Exactly what visitors get, with your monitors' real uptime."],
					)
				: h.p(
						[h.Class("text-xs text-muted-foreground")],
						[`Uptime history unavailable: ${failureMessage(model.previewFailure)}`],
					),
		],
	)

const footerBar = (h: H, model: Model): Html => {
	const isReady = canSubmit(model)
	return h.div(
		[
			h.Class(
				"sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-popover py-2 pr-2 pl-4 shadow-popup",
			),
		],
		[
			h.p([h.Class("text-xs text-muted-foreground")], ["Nothing is public until you publish."]),
			h.div(
				[h.Class("flex items-center gap-2")],
				[
					button(
						h,
						{
							size: "sm",
							variant: "outline",
							isLoading: model.submitting === "draft",
							isDisabled: !isReady,
							attributes: [h.OnClick(Message.ClickedSubmit({ mode: "draft" }))],
						},
						["Save as draft"],
					),
					button(
						h,
						{
							size: "sm",
							isLoading: model.submitting === "publish",
							isDisabled: !isReady,
							attributes: [h.OnClick(Message.ClickedSubmit({ mode: "publish" }))],
						},
						["Publish page"],
					),
				],
			),
		],
	)
}

const builder = (h: H, model: Model): Html =>
	h.div(
		[h.Class("flex flex-col gap-6")],
		[
			h.div(
				[h.Class("grid items-start gap-8 min-[1000px]:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]")],
				[
					h.div(
						// Room under the last section, so it scrolls clear of the floating publish bar.
						[h.Class("flex min-w-0 flex-col gap-8 pb-16")],
						[
							pageSection(h, model),
							componentsSection(h, model),
							lookSection(h, model),
							...(model.createFailure === null
								? []
								: [
										alert(h, { variant: "crit", size: "sm" }, [
											icon(h, "CircleXmarkIcon"),
											alertTitle(h, ["Couldn't create the page"]),
											alertDescription(h, [failureMessage(model.createFailure)]),
										]),
									]),
						],
					),
					previewPanel(h, model),
				],
			),
			footerBar(h, model),
		],
	)

const membersOnly = (h: H): Html =>
	resourceNotFound(h, {
		title: "Only org admins can create status pages",
		description: "Ask an admin to create one. You can read the existing pages.",
		back: { href: statusPagesHref(), label: "Back to status pages" },
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, _inputs, h) =>
	dashboardPage(
		h,
		{
			title: "New status page",
			actions: linkButton(h, { size: "sm", variant: "ghost", href: statusPagesHref() }, ["Cancel"]),
		},
		[
			!model.isSessionLoaded
				? h.div(
						[h.Class("flex flex-col gap-4"), h.AriaBusy(true)],
						[skeleton(h, "h-9 w-1/3"), skeleton(h, "h-64 w-full")],
					)
				: model.isAdmin
					? builder(h, model)
					: membersOnly(h),
		],
	),
)
