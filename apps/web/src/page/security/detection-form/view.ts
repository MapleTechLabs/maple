import { AuditTrailCategory, AuditTrailProvider } from "@maple/domain/audit-trail"
import { Array as Arr, Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { failureMessage } from "@maple/views/data/load-failure"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { button, linkButton } from "@maple/views/ui/button"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { inlineCode } from "@maple/views/ui/inline-code"
import { input } from "@maple/views/ui/input"
import { inputGroup, inputGroupAddon, inputGroupInput, inputGroupText } from "@maple/views/ui/input-group"
import { label } from "@maple/views/ui/label"
import { nativeOption, nativeSelect } from "@maple/views/ui/native-select"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { switchControl } from "@maple/views/ui/switch"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { ALERT_SEVERITY_LABEL } from "../../alerts/shared/badges"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { destinationPicker } from "../../kit/destination-picker"
import {
	formActionBar,
	formCard,
	formScrollArea,
	formSection,
	managersOnlyPage,
} from "../../kit/form-section"
import { resourceNotFound } from "../../kit/resource-not-found"
import { CATEGORY_LABEL, labelIn, OUTCOME_FILTERS, OUTCOME_LABEL, PROVIDER_LABEL } from "../kit/audit-labels"
import { conditionText, detectionsHref, EVERY_EVENT, isForbidden, matchText } from "../kit/detection-format"
import { DETECTION_TEMPLATES } from "../kit/detection-templates"
import { filtersOf, formIssues, thresholdOf, windowOf } from "./derive"
import type { Form, SelectField, TextField } from "./form"
import { accessOf, Message, type Model } from "./model"

type H = HtmlBuilder<Message>

const FORM_WIDTH = "max-w-3xl"

const fieldId = (field: TextField | SelectField | "template") => `detection-${field}`

const smallLabel = (h: H, field: TextField | SelectField | "template", text: string): Html =>
	label(
		h,
		{ className: typographyClass({ size: "xs", tone: "muted" }), attributes: [h.For(fieldId(field))] },
		[text],
	)

/** The ready-made detections, in the editor too: a pick fills the form and saves nothing. */
const templateSection = (h: H, model: Model): Html =>
	formSection(h, { title: "Start from", hint: "A ready-made one", isCompact: true }, [
		label(h, { className: "sr-only", attributes: [h.For(fieldId("template"))] }, ["Start from"]),
		nativeSelect(
			h,
			{
				value: model.templateId,
				className: "w-full max-w-sm",
				attributes: [h.Id(fieldId("template")), h.OnChange((id) => Message.PickedTemplate({ id }))],
			},
			[
				nativeOption("", "A blank detection"),
				...Arr.map(DETECTION_TEMPLATES, (template) => nativeOption(template.id, template.title)),
			],
		),
	])

const nameSection = (h: H, form: Form): Html =>
	formSection(h, { title: "Name", hint: "Members see it" }, [
		label(h, { className: "sr-only", attributes: [h.For(fieldId("name"))] }, ["Name"]),
		input(h, {
			id: fieldId("name"),
			attributes: [
				h.Value(form.name),
				h.Placeholder("Role changes on Vercel"),
				h.OnInput((value) => Message.ChangedText({ field: "name", value })),
			],
		}),
	])

/** One filter as a select whose first option counts everything. A stored value off the list stays listed. */
const filterSelect = (
	h: H,
	field: SelectField,
	name: string,
	value: string,
	labels: Readonly<Record<string, string>>,
	values: ReadonlyArray<string>,
): Html => {
	const listed = value === "" || values.includes(value) ? values : [...values, value]
	return vstack(h, { gap: "1.5", className: "min-w-36 flex-1" }, [
		smallLabel(h, field, name),
		nativeSelect(
			h,
			{
				value,
				className: "w-full",
				attributes: [
					h.Id(fieldId(field)),
					h.OnChange((next) => Message.ChangedSelect({ field, value: next })),
				],
			},
			[
				nativeOption("", "Any"),
				...Arr.map(listed, (option) => nativeOption(option, labelIn(labels, option))),
			],
		),
	])
}

const matchesSection = (h: H, form: Form): Html => {
	const filters = filtersOf(form)
	const labels = matchText(filters)
	return formSection(h, { title: "Matches", hint: "Events it counts" }, [
		hstack(h, { gap: "3", wrap: true, align: "start" }, [
			filterSelect(
				h,
				"provider",
				"Platform",
				form.provider,
				PROVIDER_LABEL,
				AuditTrailProvider.literals,
			),
			filterSelect(
				h,
				"category",
				"Category",
				form.category,
				CATEGORY_LABEL,
				AuditTrailCategory.literals,
			),
			filterSelect(h, "outcome", "Outcome", form.outcome, OUTCOME_LABEL, OUTCOME_FILTERS),
		]),
		vstack(h, { gap: "1.5" }, [
			smallLabel(h, "action", "Action (optional)"),
			input(h, {
				id: fieldId("action"),
				className: "font-mono",
				attributes: [
					h.Value(form.action),
					h.Placeholder("team.member.role.updated"),
					h.Attribute("autocapitalize", "off"),
					h.Attribute("spellcheck", "false"),
					h.OnInput((value) => Message.ChangedText({ field: "action", value })),
				],
			}),
			typography(h, { size: "xs", tone: "muted", as: "p" }, [
				"The platform's own action name, matched exactly, for example ",
				inlineCode(h, { variant: "plain" }, ["team.member.role.updated"]),
				". Empty counts every action.",
			]),
		]),
		typography(h, { size: "xs", tone: "muted", as: "p" }, [
			"Counts: ",
			typography(h, { tone: "foreground" }, [
				labels === "" && filters.action === undefined ? EVERY_EVENT : labels,
			]),
			...(filters.action === undefined
				? []
				: [
						labels === "" ? "" : " · ",
						inlineCode(h, { variant: "plain", tone: "foreground" }, [filters.action]),
					]),
		]),
	])
}

/** A whole number with its unit after it, so the pair reads as a clause. */
const numberField = (
	h: H,
	field: "threshold" | "windowMinutes",
	name: string,
	value: string,
	unit: string,
): Html =>
	vstack(h, { gap: "1.5", className: "w-44" }, [
		label(h, { className: "sr-only", attributes: [h.For(fieldId(field))] }, [name]),
		inputGroup(h, {}, [
			inputGroupInput(h, {
				id: fieldId(field),
				attributes: [
					h.Value(value),
					h.Attribute("inputmode", "numeric"),
					h.OnInput((next) => Message.ChangedText({ field, value: next })),
				],
			}),
			inputGroupAddon(h, { align: "inline-end" }, [inputGroupText(h, {}, [unit])]),
		]),
	])

const conditionHint = (form: Form): string =>
	Option.match(Option.all([thresholdOf(form), windowOf(form)]), {
		onNone: () => "A count from 1 to 100,000, over a window from 5 minutes to 24 hours.",
		onSome: ([threshold, windowMinutes]) =>
			`Fires on ${conditionText(threshold, windowMinutes)}. Checked every minute.`,
	})

const conditionSection = (h: H, form: Form): Html =>
	formSection(h, { title: "Fires on", hint: "Count and window" }, [
		hstack(h, { gap: "2", align: "center", wrap: true }, [
			numberField(h, "threshold", "Count", form.threshold, "or more"),
			typography(h, { size: "sm", tone: "muted" }, ["in"]),
			numberField(h, "windowMinutes", "Window in minutes", form.windowMinutes, "minutes"),
		]),
		typography(h, { size: "xs", tone: "muted", as: "p" }, [conditionHint(form)]),
	])

const severitySection = (h: H, form: Form): Html =>
	formSection(h, { title: "Severity", hint: "Of its incidents", isCompact: true }, [
		segmentedSelect(h, {
			ariaLabel: "Severity",
			size: "sm",
			className: "w-fit",
			value: form.severity,
			onChange: (severity) => Message.PickedSeverity({ severity }),
			options: [
				{ value: "warning", label: ALERT_SEVERITY_LABEL.warning },
				{ value: "critical", label: ALERT_SEVERITY_LABEL.critical },
			],
		}),
	])

const notifySection = (h: H, model: Model): Html =>
	formSection(h, { title: "Notify", hint: "When it fires" }, [
		destinationPicker(h, {
			rows: model.destinations,
			selectedIds: model.form.destinationIds,
			menu: model.destinationMenu,
			toMenuMessage: (message) => Message.GotDestinationMenuMessage({ message }),
			onRemove: (id) => Message.RemovedDestination({ id }),
			emptyText: "Nobody yet. The incident still opens, and no one is told.",
			isDisabled: model.isSaving,
		}),
		typography(h, { size: "xs", tone: "muted", as: "p" }, [
			"A notification carries the count, never an event or who caused it.",
		]),
	])

const enabledSection = (h: H, form: Form): Html =>
	formSection(h, { title: "Enabled", isCompact: true }, [
		hstack(h, { gap: "2" }, [
			...switchControl(h, {
				id: "detection-enabled",
				inputId: "detection-enabled-input",
				isChecked: form.enabled,
				labelledBy: "detection-enabled-label",
				onToggle: Message.ToggledEnabled(),
			}),
			typography(h, { size: "sm", attributes: [h.Id("detection-enabled-label")] }, [
				"Count events and open incidents",
			]),
		]),
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
						alertTitle(h, ["Couldn't save the detection"]),
						alertDescription(h, [failureMessage(model.saveFailure)]),
					]),
		actions: [
			linkButton(h, { variant: "outline", href: detectionsHref() }, ["Cancel"]),
			button(
				h,
				{
					isDisabled: issues.length > 0,
					isLoading: model.isSaving,
					attributes: [h.OnClick(Message.ClickedSave())],
				},
				[model.editingId === null ? "Create detection" : "Save changes"],
			),
		],
	})
}

const BACK = { href: detectionsHref(), label: "Back to detections" }

/** The session, or the API when the session could not say, refused the viewer. */
const isRefused = (model: Model): boolean =>
	accessOf(model) === "denied" ||
	(model.saveFailure !== null && isForbidden(model.saveFailure)) ||
	AsyncData.matchData(model.existing.data, {
		onEmpty: () => false,
		onFailure: isForbidden,
		onData: () => false,
	})

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, _inputs, h) => {
	const isEdit = model.editingId !== null
	const header = {
		title: isEdit ? "Edit detection" : "New detection",
		description: "Opens an alert incident when enough matching audit events arrive within a window.",
	}
	const loading = dashboardPage(h, header, [skeleton(h, "h-24 w-full"), skeleton(h, "h-80 w-full")])
	if (accessOf(model) === "unknown") return loading
	if (isRefused(model))
		return managersOnlyPage(h, {
			header,
			title: "Only org admins can create or change detections",
			back: BACK,
		})
	if (model.isMissing)
		return dashboardPage(h, header, [
			resourceNotFound(h, {
				title: "Detection not found",
				description: "It may have been deleted. The list shows the ones the org has now.",
				back: BACK,
			}),
		])
	if (isEdit && AsyncData.isFailure(model.existing.data))
		return dashboardPage(h, header, [
			errorState(h, {
				failure: model.existing.data.error,
				title: "Couldn't load the detection",
				onRetry: Message.ClickedRetry(),
			}),
		])
	if (isEdit && Option.isNone(AsyncData.getData(model.existing.data))) return loading
	return dashboardPage(h, { ...header, fill: true }, [
		formScrollArea(h, [
			formCard(
				h,
				[
					...(isEdit ? [] : [templateSection(h, model)]),
					nameSection(h, model.form),
					matchesSection(h, model.form),
					conditionSection(h, model.form),
					severitySection(h, model.form),
					notifySection(h, model),
					enabledSection(h, model.form),
				],
				FORM_WIDTH,
			),
		]),
		actionBar(h, model),
	])
})
