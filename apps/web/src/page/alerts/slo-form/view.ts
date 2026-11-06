import { SLO_BURN_TIERS, windowLabel } from "@maple/domain/slo"
import { Option, Array as Arr } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { failureMessage } from "@maple/views/data/load-failure"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { button, linkButton } from "@maple/views/ui/button"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { input } from "@maple/views/ui/input"
import { inputGroup, inputGroupAddon, inputGroupInput, inputGroupText } from "@maple/views/ui/input-group"
import { label } from "@maple/views/ui/label"
import { nativeOption, nativeSelect } from "@maple/views/ui/native-select"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { switchControl } from "@maple/views/ui/switch"
import { textarea } from "@maple/views/ui/textarea"
import { typography, typographyClass } from "@maple/views/ui/typography"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { destinationPicker } from "../../kit/destination-picker"
import { formActionBar, formCard, formSection } from "../../kit/form-section"
import { sloHref, slosTabHref } from "../shared/slo-commands"
import { formatPercent, formatThreshold, formatWindow } from "../shared/slo-derive"
import { budgetDowntime, formIssues, targetOf } from "./derive"
import { type Form, TARGET_PRESETS, type TextField, THRESHOLDS, type Tier, WINDOW_DAYS } from "./form"
import { Message } from "./message"
import { canManage, type Model } from "./model"

// `/alerts/slos/new`: what the SLO counts, the target and window, and who its burn-rate alerts notify.

type H = HtmlBuilder<Message>

const FORM_WIDTH = "max-w-3xl"

const fieldId = (field: TextField) => `slo-${field}`

/** A text input bound to one form field; the section names it, so its label is for screen readers. */
const textInput = (
	h: H,
	options: Readonly<{
		field: TextField
		label: string
		value: string
		placeholder?: string
		hint?: string
	}>,
): Html =>
	vstack(h, { gap: "1.5" }, [
		label(h, { className: "sr-only", attributes: [h.For(fieldId(options.field))] }, [options.label]),
		input(h, {
			id: fieldId(options.field),
			attributes: [
				h.Value(options.value),
				h.OnInput((value) => Message.ChangedText({ field: options.field, value })),
				...(options.placeholder === undefined ? [] : [h.Placeholder(options.placeholder)]),
			],
		}),
		...(options.hint === undefined
			? []
			: [typography(h, { size: "xs", tone: "muted", as: "p" }, [options.hint])]),
	])

const nameSection = (h: H, form: Form): Html =>
	formSection(h, { title: "Name" }, [
		textInput(h, { field: "name", label: "Name", value: form.name, placeholder: "Checkout API" }),
		vstack(h, { gap: "1.5" }, [
			label(
				h,
				{
					className: typographyClass({ size: "xs", tone: "muted" }),
					attributes: [h.For(fieldId("description"))],
				},
				["Description (optional)"],
			),
			textarea(h, {
				id: fieldId("description"),
				attributes: [
					h.Value(form.description),
					h.OnInput((value) => Message.ChangedText({ field: "description", value })),
					h.Placeholder("What the objective promises, for the people reading it"),
				],
			}),
		]),
	])

/** The service from the ones traced in the last day; a saved one no longer traced stays listed. */
const serviceSection = (h: H, model: Model): Html => {
	const current = model.form.serviceName
	const names =
		current === "" || model.services.includes(current) ? model.services : [current, ...model.services]
	return formSection(h, { title: "Service", hint: "Its entry-point spans are counted" }, [
		vstack(h, { gap: "1.5" }, [
			label(h, { className: "sr-only", attributes: [h.For(fieldId("serviceName"))] }, ["Service"]),
			nativeSelect(
				h,
				{
					defaultValue: current,
					className: "w-full max-w-xs",
					attributes: [
						// Keyed on the list length: a late list rebuilds the uncontrolled select, a pick keeps focus.
						h.Key(`slo-service-${names.length}`),
						h.Id(fieldId("serviceName")),
						h.OnChange((value) => Message.ChangedText({ field: "serviceName", value })),
					],
				},
				[
					nativeOption(
						"",
						names.length === 0 ? "No services traced in the last day" : "Pick a service",
					),
					...Arr.map(names, (name) => nativeOption(name, name)),
				],
			),
		]),
		textInput(h, {
			field: "environments",
			label: "Environments",
			value: model.form.environments,
			placeholder: "production, staging",
			hint: "Comma-separated. Empty counts every environment.",
		}),
	])
}

const indicatorSection = (h: H, form: Form): Html =>
	formSection(h, { title: "Indicator", hint: "What a good event is", isCompact: true }, [
		segmentedSelect(h, {
			ariaLabel: "Indicator",
			size: "sm",
			className: "w-fit",
			value: form.sliType,
			onChange: (sliType) => Message.PickedSliType({ sliType }),
			options: [
				{ value: "availability", label: "Availability" },
				{ value: "latency", label: "Latency" },
			],
		}),
		...(form.sliType === "latency"
			? [
					segmentedSelect(h, {
						ariaLabel: "Latency threshold",
						size: "sm",
						className: "w-fit flex-wrap",
						value: String(form.thresholdMs),
						onChange: (value) =>
							Option.match(
								Arr.findFirst(THRESHOLDS, (ms) => String(ms) === value),
								{
									onNone: () => Message.PickedThreshold({ thresholdMs: form.thresholdMs }),
									onSome: (thresholdMs) => Message.PickedThreshold({ thresholdMs }),
								},
							),
						options: Arr.map(THRESHOLDS, (ms) => ({
							value: String(ms),
							label: formatThreshold(ms),
						})),
					}),
				]
			: []),
		typography(h, { size: "xs", tone: "muted", as: "p" }, [
			form.sliType === "availability"
				? "Good events are entry-point spans whose status is not Error."
				: `Good events are entry-point spans faster than ${formatThreshold(form.thresholdMs)}.`,
		]),
	])

const targetHint = (form: Form): string =>
	Option.match(targetOf(form), {
		onNone: () => "Between 50% and 99.999%.",
		onSome: (target) =>
			`An error budget of ${formatPercent(100 - target)} of events, about ${budgetDowntime(target, form.windowDays)} of full outage over ${formatWindow(form.windowDays)}.`,
	})

const targetSection = (h: H, form: Form): Html =>
	formSection(h, { title: "Target", isCompact: true }, [
		segmentedSelect(h, {
			ariaLabel: "Target",
			size: "sm",
			className: "w-fit flex-wrap",
			value: form.target,
			onChange: (target) => Message.PickedTarget({ target }),
			options: [
				...Arr.map(TARGET_PRESETS, (preset) => ({ value: preset, label: `${preset}%` })),
				{ value: "custom" as const, label: "Custom" },
			],
		}),
		...(form.target === "custom"
			? [
					vstack(h, { gap: "1.5", className: "w-40" }, [
						label(h, { className: "sr-only", attributes: [h.For(fieldId("customTarget"))] }, [
							"Custom target",
						]),
						inputGroup(h, {}, [
							inputGroupInput(h, {
								id: fieldId("customTarget"),
								attributes: [
									h.Value(form.customTarget),
									h.Attribute("inputmode", "decimal"),
									h.Placeholder("99.8"),
									h.OnInput((value) =>
										Message.ChangedText({ field: "customTarget", value }),
									),
								],
							}),
							inputGroupAddon(h, { align: "inline-end" }, [inputGroupText(h, {}, ["%"])]),
						]),
					]),
				]
			: []),
		typography(h, { size: "xs", tone: "muted", as: "p" }, [targetHint(form)]),
	])

const windowSection = (h: H, form: Form): Html =>
	formSection(h, { title: "Window", hint: "Rolling", isCompact: true }, [
		segmentedSelect(h, {
			ariaLabel: "Window",
			size: "sm",
			className: "w-fit",
			value: String(form.windowDays),
			onChange: (value) =>
				Option.match(
					Arr.findFirst(WINDOW_DAYS, (days) => String(days) === value),
					{
						onNone: () => Message.PickedWindow({ windowDays: form.windowDays }),
						onSome: (windowDays) => Message.PickedWindow({ windowDays }),
					},
				),
			options: Arr.map(WINDOW_DAYS, (days) => ({ value: String(days), label: formatWindow(days) })),
		}),
	])

const TIER_COPY = {
	critical: { title: "Critical", role: "Pages", note: "" },
	warning: { title: "Warning", role: "Opens a ticket", note: " A critical incident notifies these too." },
} as const satisfies Record<Tier, Readonly<{ title: string; role: string; note: string }>>

/** Each tier's line, from the factors and windows the evaluator uses. */
const TIERS = Arr.map(SLO_BURN_TIERS, (tier) => {
	const copy = TIER_COPY[tier.severity]
	return {
		tier: tier.severity,
		title: copy.title,
		rule: `${copy.role} when the budget burns at ${tier.factor}x over ${windowLabel(tier.longWindowMinutes)} and ${windowLabel(tier.shortWindowMinutes)}.${copy.note}`,
	}
})

const tierPicker = (h: H, model: Model, entry: (typeof TIERS)[number]): Html =>
	vstack(h, { gap: "1.5", attributes: [h.Key(entry.tier)] }, [
		hstack(h, { gap: "2", align: "baseline", wrap: true }, [
			typography(h, { size: "sm", weight: "medium" }, [entry.title]),
			typography(h, { size: "xs", tone: "muted" }, [entry.rule]),
		]),
		destinationPicker(h, {
			rows: model.destinations,
			selectedIds:
				entry.tier === "critical"
					? model.form.criticalDestinationIds
					: model.form.warningDestinationIds,
			menu: entry.tier === "critical" ? model.criticalMenu : model.warningMenu,
			toMenuMessage: (message) => Message.GotDestinationMenuMessage({ tier: entry.tier, message }),
			onRemove: (id) => Message.RemovedDestination({ tier: entry.tier, id }),
			emptyText: "Nobody yet. The incident still opens in the inbox.",
		}),
	])

const alertingSection = (h: H, model: Model): Html =>
	formSection(h, { title: "Alerting", hint: "Multiwindow burn rate", isCompact: true }, [
		hstack(h, { gap: "2" }, [
			...switchControl(h, {
				id: "slo-form-alerting",
				inputId: "slo-form-alerting-input",
				isChecked: model.form.alertingEnabled,
				labelledBy: "slo-form-alerting-label",
				onToggle: Message.ToggledAlerting(),
			}),
			typography(h, { size: "sm", attributes: [h.Id("slo-form-alerting-label")] }, [
				"Open incidents when the error budget burns too fast",
			]),
		]),
		...(model.form.alertingEnabled ? Arr.map(TIERS, (entry) => tierPicker(h, model, entry)) : []),
	])

const actionBar = (h: H, model: Model): Html => {
	const issues = formIssues(model.form)
	return formActionBar(h, {
		issues,
		widthClass: FORM_WIDTH,
		notice:
			model.saveFailure === null
				? null
				: alert(h, { variant: "crit", size: "sm", className: `mb-3 ${FORM_WIDTH}` }, [
						icon(h, "CircleXmarkIcon"),
						alertTitle(h, ["Couldn't save the SLO"]),
						alertDescription(h, [failureMessage(model.saveFailure)]),
					]),
		actions: [
			linkButton(
				h,
				{
					variant: "outline",
					href: model.editingId === null ? slosTabHref() : sloHref(model.editingId),
				},
				["Cancel"],
			),
			button(
				h,
				{
					// Until the session says this is a manager, a click would be dropped by `save`.
					isDisabled: issues.length > 0 || !canManage(model),
					isLoading: model.isSaving,
					attributes: [h.OnClick(Message.ClickedSave())],
				},
				[model.editingId === null ? "Create SLO" : "Save changes"],
			),
		],
	})
}

/** Members can read SLOs but not create or change them; the API refuses them too. */
const managersOnlyPage = (h: H, model: Model, header: Readonly<{ title: string; description: string }>) =>
	dashboardPage(h, header, [
		alert(h, { variant: "info" }, [
			icon(h, "ShieldIcon"),
			alertTitle(h, ["Only org admins and engineers can create or change SLOs"]),
			alertDescription(h, ["Ask an admin to make this change."]),
		]),
		h.div(
			[],
			[
				linkButton(
					h,
					{
						variant: "outline",
						href: model.editingId === null ? slosTabHref() : sloHref(model.editingId),
					},
					[model.editingId === null ? "Back to SLOs" : "Back to the SLO"],
				),
			],
		),
	])

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, _inputs, h) => {
	const isEdit = model.editingId !== null
	const header = {
		title: isEdit ? "Edit SLO" : "New SLO",
		description: "The share of a service's requests that must be good, and the error budget that leaves.",
	}
	if (model.isSessionLoaded && !canManage(model)) return managersOnlyPage(h, model, header)
	if (isEdit && AsyncData.isFailure(model.existing.data))
		return dashboardPage(h, header, [
			errorState(h, { failure: model.existing.data.error, title: "Couldn't load the SLO" }),
		])
	if (isEdit && !AsyncData.isSuccess(model.existing.data) && !AsyncData.isRefreshing(model.existing.data))
		return dashboardPage(h, header, [skeleton(h, "h-24 w-full"), skeleton(h, "h-80 w-full")])
	return dashboardPage(h, { ...header, fill: true }, [
		h.div(
			[h.DataAttribute("slot", "page-scroll-area"), h.Class("min-h-0 flex-1 overflow-auto p-4")],
			[
				formCard(
					h,
					[
						nameSection(h, model.form),
						serviceSection(h, model),
						indicatorSection(h, model.form),
						targetSection(h, model.form),
						windowSection(h, model.form),
						alertingSection(h, model),
					],
					FORM_WIDTH,
				),
			],
		),
		actionBar(h, model),
	])
})
