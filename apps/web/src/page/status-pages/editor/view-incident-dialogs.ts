import {
	type StatusPageComponentId,
	StatusPageIncidentImpact,
	type StatusPageIncidentStatus,
} from "@maple/domain"
import type { V2StatusPage, V2StatusPageIncident } from "@maple/domain/http/v2"
import { INCIDENT_STATUS_LABEL, renderUpdateBody } from "@maple/status-page"
import type { Tone } from "@maple/ui/lib/tone"
import { formatTimestampInTimezone } from "@maple/ui/lib/timezone-format"
import { Option, Array as Arr, String as Str } from "effect"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { accentCard } from "@maple/views/ui/accent-card"
import { borderedBox } from "@maple/views/ui/bordered-box"
import { button } from "@maple/views/ui/button"
import * as Checkbox from "@maple/views/ui/checkbox"
import type * as Dialog from "@maple/views/ui/dialog"
import * as DialogView from "@maple/views/ui/dialog-view"
import { badge } from "@maple/views/ui/display"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { formDialog, formDialogForm } from "@maple/views/ui/form-dialog"
import { grid } from "@maple/views/ui/grid"
import { icon } from "@maple/views/ui/icon"
import { label } from "@maple/views/ui/label"
import { dividedList } from "@maple/views/ui/rule"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { hstack, vstack, vstackClass } from "@maple/views/ui/stack"
import { statusDot } from "@maple/views/ui/status-dot"
import { stepTrail } from "@maple/views/ui/step-trail"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"
import { relativeTime } from "../../kit/relative-time"
import {
	closingStatus,
	COMPONENT_STATUS_LABEL,
	COMPONENT_STATUS_TONE,
	IMPACT_LABEL,
	IMPACT_TONE,
	type StatusChange,
	statusChanges,
	STATUSES_OF_KIND,
} from "../shared/derive"
import { selectField, textareaField, textField } from "../shared/fields"
import {
	editableTimes,
	endedIssue,
	incidentEditIssues,
	incidentIssues,
	localToIso,
	updateBodyLengthIssue,
	type UpdateForm,
} from "../shared/form"
import { Message } from "./message"
import type { ComposeStep, Model } from "./model"
import { componentsOf, incidentsOf, monitorsOf } from "./reads"
import { pageUrlOf } from "./update-domain"
import { failureAlert, type TimeInputs, windowLine } from "./view-panel"

// Post incident and Post update: write it, then review how it reads and what it changes on the
// page before it goes out. Edit details opens on its own, or over Post update.

type H = HtmlBuilder<Message>
type Close = ReadonlyArray<ChildAttribute>

/** What the public page renders in an update, so authors know before they post. */
const MESSAGE_HINT = "Supports **bold**, *italic*, `code`, lists and links."

const DIALOG_CLASS = "sm:max-w-160"

/** The public page's update markup: paragraphs, lists, code and links. */
const MESSAGE_CLASS =
	"space-y-2 text-sm text-foreground-soft [&_a]:text-primary [&_a]:underline [&_code]:font-mono [&_code]:text-xs [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5"

const header = (
	h: H,
	id: string,
	options: Readonly<{ step: ComposeStep; title: string; description?: ReadonlyArray<Html | string> }>,
): Html =>
	DialogView.dialogHeader(h, "dialog", [
		stepTrail(h, { steps: ["Write", "Review"], current: options.step === "write" ? 0 : 1 }),
		DialogView.dialogTitle(h, "dialog", id, options.title),
		...(options.description === undefined
			? []
			: [
					DialogView.dialogDescription(h, "dialog", id, [
						typography(h, { size: "xs", mono: true }, options.description),
					]),
				]),
	])

const stepDialog = (
	h: H,
	options: Readonly<{
		slotId: string
		model: Dialog.Model
		toParentMessage: (message: Dialog.Message) => Message
		hasDescription: boolean
		nestedDialogs?: number
		content: (close: Close) => ReadonlyArray<Html>
	}>,
): Html =>
	h.submodel({
		slotId: options.slotId,
		model: options.model,
		view: DialogView.view,
		toParentMessage: options.toParentMessage,
		viewInputs: {
			hasTrigger: false,
			className: DIALOG_CLASS,
			hasDescription: options.hasDescription,
			nestedDialogs: options.nestedDialogs,
			toView: ({ portal }) => portal ?? h.empty,
			toContent: options.content,
		},
	})

const namesOf = (model: Model, ids: ReadonlyArray<StatusPageComponentId>): ReadonlyArray<string> =>
	Arr.map(
		Arr.filter(componentsOf(model), (component) => ids.includes(component.id)),
		(component) => component.name,
	)

/** "Affects API, Webhooks", or every component at once; nothing when none is named. */
const affectsLine = (model: Model, ids: ReadonlyArray<StatusPageComponentId>): ReadonlyArray<string> => {
	const names = namesOf(model, ids)
	if (names.length === 0) return []
	return [
		names.length > 1 && names.length === componentsOf(model).length
			? "Affects all components"
			: `Affects ${Arr.join(names, ", ")}`,
	]
}

const joined = (parts: ReadonlyArray<ReadonlyArray<Html | string>>): ReadonlyArray<Html | string> =>
	Arr.flatMap(parts, (part, index) => (index === 0 ? part : [" · ", ...part]))

const impactDot = (h: H, impact: V2StatusPageIncident["impact"]): Html =>
	statusDot(h, { tone: IMPACT_TONE[impact], size: "lg" })

/** The page's components as checkboxes, two columns, each with its group. */
const componentChecklist = (
	h: H,
	model: Model,
	options: Readonly<{
		checkedIds: ReadonlyArray<StatusPageComponentId>
		idPrefix: string
		onToggle: (componentId: StatusPageComponentId) => Message
	}>,
): Html => {
	const components = componentsOf(model)
	return h.fieldset(
		[h.Class(vstackClass({ gap: "1.5" }))],
		[
			h.legend([h.Class("mb-1.5 text-xs text-muted-foreground")], ["Affected components"]),
			components.length === 0
				? typography(h, { size: "xs", tone: "muted", as: "p" }, ["The page has no components yet."])
				: borderedBox(
						h,
						{ overflow: "hidden", className: "grid gap-x-4 gap-y-2 p-3 sm:grid-cols-2" },
						Arr.map(components, (component) => {
							const inputId = `${options.idPrefix}-${component.id}`
							return label(
								h,
								{
									className: "flex min-w-0 font-normal text-sm sm:text-sm",
									attributes: [h.Key(component.id), h.Id(Checkbox.labelId(inputId))],
								},
								[
									...Checkbox.view(h, {
										model: { isChecked: options.checkedIds.includes(component.id) },
										toParentMessage: () => options.onToggle(component.id),
										id: `${inputId}-root`,
										inputId,
									}),
									typography(h, { truncate: true }, [component.name]),
									...(component.group === null
										? []
										: [
												typography(h, { size: "xs", tone: "muted", truncate: true }, [
													component.group,
												]),
											]),
								],
							)
						}),
					),
		],
	)
}

// REVIEW

const reviewSection = (h: H, title: string, body: Html): Html =>
	vstack(h, { gap: "2", as: "section", attributes: [h.AriaLabel(title)] }, [
		eyebrow(h, { as: "h3" }, [title]),
		body,
	])

/** The post as the page shows it: title and status, the rendered message, what it affects. */
const previewCard = (
	h: H,
	options: Readonly<{
		title: string
		status: StatusPageIncidentStatus
		tone: Tone
		body: string
		meta: ReadonlyArray<Html | string>
	}>,
): Html =>
	accentCard(h, { tone: options.tone }, [
		hstack(h, { gap: "2", justify: "between", align: "start" }, [
			typography(h, { size: "sm", weight: "semibold" }, [options.title]),
			badge(
				h,
				{
					variant:
						options.status === "resolved" || options.status === "completed" ? "muted" : "info",
				},
				[INCIDENT_STATUS_LABEL[options.status]],
			),
		]),
		h.div(
			[
				h.Class(MESSAGE_CLASS),
				h.DataAttribute("slot", "update-body"),
				h.InnerHTML(renderUpdateBody(options.body)),
			],
			[],
		),
		typography(h, { size: "xs", tone: "muted", as: "p" }, options.meta),
	])

/** The banner and each component whose status would change, before and after. */
const changesList = (h: H, changes: ReadonlyArray<StatusChange>): Html =>
	changes.length === 0
		? typography(h, { size: "sm", tone: "muted", as: "p" }, ["Nothing on the page changes"])
		: dividedList(
				h,
				{ as: "ul" },
				Arr.map(changes, (change) =>
					h.li(
						[
							h.Key(change.componentId ?? "banner"),
							h.Class("grid h-9 grid-cols-[7.5rem_minmax(0,1fr)] items-center gap-3 px-3"),
						],
						[
							typography(h, { size: "sm", truncate: true }, [change.label]),
							hstack(h, { gap: "2", shrink: true }, [
								typography(h, { size: "sm", tone: "muted" }, [
									COMPONENT_STATUS_LABEL[change.from],
								]),
								icon(h, "ArrowRightIcon", {
									size: 12,
									className: "shrink-0 text-muted-foreground",
								}),
								statusDot(h, { tone: COMPONENT_STATUS_TONE[change.to] }),
								typography(h, { size: "sm", weight: "medium" }, [
									COMPONENT_STATUS_LABEL[change.to],
								]),
							]),
						],
					),
				),
			)

// POST INCIDENT

const statusEntries = (kind: V2StatusPageIncident["kind"]) =>
	Arr.map(
		Arr.filter(STATUSES_OF_KIND[kind], (status) => status !== closingStatus(kind)),
		(status) => ({ value: status, label: INCIDENT_STATUS_LABEL[status] }),
	)

const IMPACT_ENTRIES = Arr.map(StatusPageIncidentImpact.literals, (impact) => ({
	value: impact,
	label: IMPACT_LABEL[impact],
}))

/** "Acme Status · status.maple.dev/s/acme": the page and where visitors read it. */
const pageLine = (model: Model, page: V2StatusPage): ReadonlyArray<string> => {
	const url = pageUrlOf(model, page)
	return url === null ? [page.name] : [page.name, " · ", Str.replace(/^https?:\/\//u, "")(url)]
}

const composeWrite = (h: H, model: Model, page: V2StatusPage, timeZone: string, close: Close) => {
	const form = model.incidentForm
	const id = model.composeDialog.id
	const isMaintenance = form.kind === "maintenance"
	const issues = incidentIssues(form, timeZone)
	const issue = issues.title ?? issues.body ?? issues.window
	return [
		header(h, id, {
			step: "write",
			title: isMaintenance ? "Schedule maintenance" : "Post incident",
			description: pageLine(model, page),
		}),
		formDialogForm(h, Message.SubmittedIncidentWrite(), [
			DialogView.dialogPanel(h, "dialog", id, [
				vstack(h, { gap: "4" }, [
					segmentedSelect(h, {
						size: "sm",
						ariaLabel: "Kind",
						className: "self-start",
						value: form.kind,
						onChange: (kind) => Message.ChangedIncidentKind({ kind }),
						options: [
							{ value: "incident", label: "Incident" },
							{ value: "maintenance", label: "Maintenance" },
						],
					}),
					textField(h, {
						id: "status-page-incident-title-field",
						label: "Title",
						value: form.title,
						placeholder: isMaintenance ? "Database upgrade" : "Elevated API errors",
						onInput: (value) => Message.ChangedIncidentField({ field: "title", value }),
					}),
					grid(h, { sm: 2, gap: "4" }, [
						selectField(h, {
							id: "status-page-incident-status",
							label: "Status",
							value: form.status,
							entries: statusEntries(form.kind),
							onInput: (value) => Message.ChangedIncidentField({ field: "status", value }),
						}),
						...(isMaintenance
							? []
							: [
									selectField(h, {
										id: "status-page-incident-impact",
										label: "Impact",
										value: form.impact,
										entries: IMPACT_ENTRIES,
										leading: impactDot(h, form.impact),
										onInput: (value) =>
											Message.ChangedIncidentField({ field: "impact", value }),
									}),
								]),
					]),
					...(isMaintenance
						? []
						: [
								grid(h, { sm: 2, gap: "4" }, [
									textField(h, {
										id: "status-page-incident-started",
										label: "Started",
										type: "datetime-local",
										value: form.startedAt,
										hint: `Leave empty if it started now. Times are in ${timeZone}.`,
										onInput: (value) =>
											Message.ChangedIncidentField({ field: "startedAt", value }),
									}),
								]),
							]),
					...(isMaintenance
						? [
								grid(h, { sm: 2, gap: "4" }, [
									textField(h, {
										id: "status-page-incident-start",
										label: "Starts",
										type: "datetime-local",
										value: form.scheduledStart,
										onInput: (value) =>
											Message.ChangedIncidentField({ field: "scheduledStart", value }),
									}),
									textField(h, {
										id: "status-page-incident-end",
										label: "Ends",
										type: "datetime-local",
										value: form.scheduledEnd,
										hint: `Times are in ${timeZone}.`,
										onInput: (value) =>
											Message.ChangedIncidentField({ field: "scheduledEnd", value }),
									}),
								]),
							]
						: []),
					componentChecklist(h, model, {
						checkedIds: form.componentIds,
						idPrefix: "status-page-incident-component",
						onToggle: (componentId) => Message.ToggledIncidentComponent({ componentId }),
					}),
					textareaField(h, {
						id: "status-page-incident-body",
						label: "Message",
						value: form.body,
						controlClassName: "min-h-30",
						placeholder: isMaintenance
							? "We are upgrading the primary database. Expect brief read-only periods."
							: "We are looking into elevated error rates on the API.",
						hint: MESSAGE_HINT,
						error: updateBodyLengthIssue(form.body),
						onInput: (value) => Message.ChangedIncidentField({ field: "body", value }),
					}),
				]),
			]),
			DialogView.dialogFooter(h, "dialog", [
				DialogView.dialogFooterHint(
					h,
					issue ?? "Nothing is public until you confirm on the next step.",
				),
				button(h, { variant: "outline", attributes: close }, ["Cancel"]),
				button(h, { type: "submit", isDisabled: issue !== null }, ["Review"]),
			]),
		]),
	]
}

const rangeLabel = (iso: string, timeZone: string): string =>
	formatTimestampInTimezone(iso, { timeZone, style: "range" })

/** What the maintenance does on its own, from the window as typed. */
const scheduleNote = (
	start: string,
	end: string,
	status: StatusPageIncidentStatus,
	timeZone: string,
): string | null =>
	Option.match(Option.all([localToIso(start, timeZone), localToIso(end, timeZone)]), {
		onNone: () => null,
		onSome: ([from, to]) =>
			status === "in_progress"
				? `In progress now, ends ${rangeLabel(to, timeZone)} (${timeZone}). It moves to Completed on its own at the end; subscribers see that update.`
				: `Starts ${rangeLabel(from, timeZone)} and ends ${rangeLabel(to, timeZone)} (${timeZone}). It moves to In progress at the start and to Completed at the end on its own; subscribers see both updates.`,
	})

/** "Oct 28, 14:00 to 16:00", from the window as typed. */
const draftWindow = (start: string, end: string, timeZone: string): ReadonlyArray<string> =>
	Option.match(Option.all([localToIso(start, timeZone), localToIso(end, timeZone)]), {
		onNone: () => [],
		onSome: ([from, to]) => [`${rangeLabel(from, timeZone)} to ${rangeLabel(to, timeZone)}`],
	})

const composeReview = (h: H, model: Model, time: TimeInputs) => {
	const form = model.incidentForm
	const id = model.composeDialog.id
	const isMaintenance = form.kind === "maintenance"
	const isCreating = model.isCreatingIncident
	const incidents = incidentsOf(model)
	const changes = statusChanges({
		components: componentsOf(model),
		monitors: monitorsOf(model),
		before: incidents,
		after: [
			...incidents,
			{
				published: true,
				kind: form.kind,
				status: form.status,
				impact: form.impact,
				component_ids: form.componentIds,
			},
		],
	})
	const schedule = isMaintenance
		? scheduleNote(form.scheduledStart, form.scheduledEnd, form.status, time.timeZone)
		: null
	const started = isMaintenance ? Option.none() : localToIso(form.startedAt, time.timeZone)
	const isScheduling =
		isMaintenance &&
		Option.match(localToIso(form.scheduledStart, time.timeZone), {
			onNone: () => false,
			onSome: (start) => start > new Date(time.nowMs).toISOString(),
		})
	return [
		header(h, id, { step: "review", title: "Review before publishing" }),
		DialogView.dialogPanel(h, "dialog", id, [
			vstack(h, { gap: "5" }, [
				reviewSection(
					h,
					"On the page",
					previewCard(h, {
						title: Str.trim(form.title),
						status: form.status,
						tone: isMaintenance ? "info" : IMPACT_TONE[form.impact],
						body: form.body,
						meta: joined([
							affectsLine(model, form.componentIds),
							...(isMaintenance
								? [draftWindow(form.scheduledStart, form.scheduledEnd, time.timeZone)]
								: []),
							...Option.match(started, {
								onNone: () => [],
								onSome: (at) => [[`Started ${rangeLabel(at, time.timeZone)}`]],
							}),
							["Posted just now"],
						]),
					}),
				),
				...(schedule === null
					? []
					: [
							reviewSection(
								h,
								"Schedule",
								typography(h, { size: "sm", tone: "muted", as: "p" }, [schedule]),
							),
						]),
				reviewSection(h, "What changes", changesList(h, changes)),
				...failureAlert(
					h,
					isMaintenance ? "Couldn't schedule it" : "Couldn't open the incident",
					model.incidentFailure,
				),
			]),
		]),
		DialogView.dialogFooter(h, "dialog", [
			button(
				h,
				{
					variant: "outline",
					className: "sm:me-auto",
					isDisabled: isCreating,
					attributes: [h.OnClick(Message.ClickedIncidentBack())],
				},
				["Back"],
			),
			button(
				h,
				{
					variant: "outline",
					isLoading: isCreating && !form.isPublished,
					isDisabled: isCreating,
					attributes: [h.OnClick(Message.SubmittedIncident({ isPublished: false }))],
				},
				["Save as draft"],
			),
			button(
				h,
				{
					isLoading: isCreating && form.isPublished,
					isDisabled: isCreating,
					attributes: [h.OnClick(Message.SubmittedIncident({ isPublished: true }))],
				},
				[isScheduling ? "Schedule" : "Publish"],
			),
		]),
	]
}

const composeDialogView = (h: H, model: Model, page: V2StatusPage, time: TimeInputs): Html =>
	stepDialog(h, {
		slotId: "status-page-compose",
		model: model.composeDialog,
		toParentMessage: (message) => Message.GotComposeDialogMessage({ message }),
		hasDescription: model.composeStep === "write",
		content: (close) =>
			model.composeStep === "write"
				? composeWrite(h, model, page, time.timeZone, close)
				: composeReview(h, model, time),
	})

// POST UPDATE

/** "Identified for 24m": the status and how long it has held, from the updates that set it. */
const statusSince = (h: H, incident: V2StatusPageIncident, time: TimeInputs): Html => {
	const since = Arr.last(Arr.takeWhile(incident.updates, (update) => update.status === incident.status))
	return relativeTime(h, {
		value: Option.match(since, {
			onNone: () => incident.started_at,
			onSome: (update) => update.created_at,
		}),
		nowMs: time.nowMs,
		timeZone: time.timeZone,
		variant: "short",
		prefix: `${INCIDENT_STATUS_LABEL[incident.status]} for`,
	})
}

const updateWrite = (
	h: H,
	model: Model,
	incident: V2StatusPageIncident,
	form: UpdateForm,
	time: TimeInputs,
	close: Close,
) => {
	const id = model.updateDialog.id
	const last = incident.updates[0]
	const names = namesOf(model, incident.component_ids)
	const tooLong = updateBodyLengthIssue(form.body)
	const ended = endedIssue(form, incident.started_at, time.timeZone)
	return [
		header(h, id, {
			step: "write",
			title: "Post update",
			description: joined([
				[incident.title],
				[statusSince(h, incident, time)],
				...(names.length === 0 ? [] : [[Arr.join(names, ", ")]]),
			]),
		}),
		formDialogForm(h, Message.SubmittedUpdateWrite(), [
			DialogView.dialogPanel(h, "dialog", id, [
				vstack(h, { gap: "4" }, [
					...(last === undefined
						? []
						: [
								accentCard(h, { tone: "neutral", size: "sm" }, [
									hstack(h, { gap: "1.5" }, [
										eyebrow(h, {}, ["Last update"]),
										typography(h, { size: "2xs", tone: "muted" }, [
											"· ",
											relativeTime(h, {
												value: last.created_at,
												nowMs: time.nowMs,
												timeZone: time.timeZone,
											}),
										]),
									]),
									typography(h, { size: "sm", tone: "muted", truncate: true, as: "p" }, [
										last.body,
									]),
								]),
							]),
					vstack(h, { gap: "1.5" }, [
						typography(h, { size: "xs", tone: "muted" }, ["Status"]),
						segmentedSelect(h, {
							ariaLabel: "Status",
							size: "sm",
							className: "self-start",
							value: form.status,
							onChange: (value) => Message.ChangedUpdateField({ field: "status", value }),
							options: Arr.map(STATUSES_OF_KIND[form.kind], (status) => ({
								value: status,
								label: INCIDENT_STATUS_LABEL[status],
							})),
						}),
						...(form.status === closingStatus(form.kind)
							? [
									typography(h, { size: "xs", tone: "muted", as: "p" }, [
										"This closes it on the page.",
									]),
								]
							: []),
					]),
					...(form.status === closingStatus(form.kind)
						? [
								grid(h, { sm: 2, gap: "4" }, [
									textField(h, {
										id: "status-page-update-ended",
										label: "Ended",
										type: "datetime-local",
										value: form.endedAt,
										hint: `Leave empty if it ended now. Times are in ${time.timeZone}.`,
										error: ended,
										onInput: (value) =>
											Message.ChangedUpdateField({ field: "endedAt", value }),
									}),
								]),
							]
						: []),
					textareaField(h, {
						id: "status-page-update-body",
						label: "Message",
						value: form.body,
						controlClassName: "min-h-25",
						hint: MESSAGE_HINT,
						error: tooLong,
						onInput: (value) => Message.ChangedUpdateField({ field: "body", value }),
					}),
					textLink(
						h,
						{
							tone: "muted",
							className: "self-start underline",
							onClick: Message.ClickedEditIncident({ incidentId: incident.id }),
						},
						["Change title, impact, times or components"],
					),
				]),
			]),
			DialogView.dialogFooter(h, "dialog", [
				button(h, { variant: "outline", attributes: close }, ["Cancel"]),
				button(
					h,
					{
						type: "submit",
						isDisabled: Str.trim(form.body) === "" || tooLong !== null || ended !== null,
					},
					["Review"],
				),
			]),
		]),
	]
}

const updateReview = (
	h: H,
	model: Model,
	incident: V2StatusPageIncident,
	state: Extract<Model["updateForm"], { readonly _tag: "Reviewing" | "Posting" | "Failed" }>,
	time: TimeInputs,
) => {
	const form = state.form
	const id = model.updateDialog.id
	const isPosting = state._tag === "Posting"
	const incidents = incidentsOf(model)
	const changes = statusChanges({
		components: componentsOf(model),
		monitors: monitorsOf(model),
		before: incidents,
		after: Arr.map(incidents, (row) => (row.id === incident.id ? { ...row, status: form.status } : row)),
	})
	const window = windowLine(h, incident, time.timeZone)
	const endedAt =
		form.status === closingStatus(form.kind) ? localToIso(form.endedAt, time.timeZone) : Option.none()
	return [
		header(h, id, { step: "review", title: "Review before publishing" }),
		DialogView.dialogPanel(h, "dialog", id, [
			vstack(h, { gap: "5" }, [
				reviewSection(
					h,
					"On the page",
					previewCard(h, {
						title: incident.title,
						status: form.status,
						tone: incident.kind === "maintenance" ? "info" : IMPACT_TONE[incident.impact],
						body: form.body,
						meta: joined([
							affectsLine(model, incident.component_ids),
							...(window === null ? [] : [window]),
							...Option.match(endedAt, {
								onNone: () => [],
								onSome: (at) => [[`Ended ${rangeLabel(at, time.timeZone)}`]],
							}),
							["Posted just now"],
						]),
					}),
				),
				reviewSection(h, "What changes", changesList(h, changes)),
				...failureAlert(
					h,
					"Couldn't post the update",
					state._tag === "Failed" ? state.failure : null,
				),
			]),
		]),
		DialogView.dialogFooter(h, "dialog", [
			button(
				h,
				{
					variant: "outline",
					className: "sm:me-auto",
					isDisabled: isPosting,
					attributes: [h.OnClick(Message.ClickedUpdateBack())],
				},
				["Back"],
			),
			button(h, { isLoading: isPosting, attributes: [h.OnClick(Message.SubmittedUpdate())] }, [
				"Publish update",
			]),
		]),
	]
}

const updateDialogView = (h: H, model: Model, time: TimeInputs): Html => {
	const state = model.updateForm
	const incident =
		state._tag === "Closed"
			? undefined
			: Option.getOrUndefined(
					Arr.findFirst(incidentsOf(model), (row) => row.id === state.form.incidentId),
				)
	return stepDialog(h, {
		slotId: "status-page-update",
		model: model.updateDialog,
		toParentMessage: (message) => Message.GotUpdateDialogMessage({ message }),
		hasDescription: state._tag === "Writing",
		nestedDialogs: model.editIncidentDialog.isOpen ? 1 : 0,
		content: (close) =>
			state._tag === "Closed" || incident === undefined
				? []
				: state._tag === "Writing"
					? updateWrite(h, model, incident, state.form, time, close)
					: updateReview(h, model, incident, state, time),
	})
}

// EDIT DETAILS

/** The start and end Edit details offers, side by side; the last one carries the zone or the error. */
const timeFields = (
	h: H,
	form: NonNullable<Model["incidentEdit"]>,
	error: string | null,
	timeZone: string,
): ReadonlyArray<Html> => {
	const editable = editableTimes(form)
	const isMaintenance = form.kind === "maintenance"
	const fields = [
		...(editable.start
			? [{ field: "start" as const, label: isMaintenance ? "Starts" : "Started", value: form.start }]
			: []),
		...(editable.end
			? [{ field: "end" as const, label: isMaintenance ? "Ends" : "Ended", value: form.end }]
			: []),
	]
	return fields.length === 0
		? []
		: [
				grid(
					h,
					{ sm: 2, gap: "4" },
					Arr.map(fields, (entry, index) =>
						textField(h, {
							id: `status-page-incident-edit-${entry.field}`,
							label: entry.label,
							type: "datetime-local",
							value: entry.value,
							...(index === fields.length - 1
								? {
										hint: isMaintenance
											? `Times are in ${timeZone}. It moves to In progress and Completed on its own.`
											: `Times are in ${timeZone}.`,
										error,
									}
								: undefined),
							onInput: (value) =>
								Message.ChangedIncidentEditField({ field: entry.field, value }),
						}),
					),
				),
			]
}

/** Title, impact, times and components, changed in place: saving posts no update. */
const editDialogView = (h: H, model: Model, timeZone: string): Html => {
	const form = model.incidentEdit
	const issues = form === null ? null : incidentEditIssues(form, timeZone)
	const isBlank = issues === null || issues.title !== null
	return formDialog(h, {
		slotId: "status-page-edit-incident",
		model: model.editIncidentDialog,
		toParentMessage: (message) => Message.GotEditIncidentDialogMessage({ message }),
		title: "Edit details",
		description: "Saved without posting an update. To tell visitors what changed, post one.",
		onSubmit: Message.SubmittedIncidentEdit(),
		submitLabel: "Save changes",
		isPending: model.isSavingIncident,
		isSubmitDisabled: isBlank || (issues?.times ?? null) !== null,
		isNested: model.updateDialog.isOpen,
		className: DIALOG_CLASS,
		fields:
			form === null
				? []
				: [
						textField(h, {
							id: "status-page-incident-edit-title",
							label: "Title",
							value: form.title,
							error: isBlank ? "Add a title." : null,
							onInput: (value) => Message.ChangedIncidentEditField({ field: "title", value }),
						}),
						...(form.kind === "incident"
							? [
									selectField(h, {
										id: "status-page-incident-edit-impact",
										label: "Impact",
										value: form.impact,
										entries: IMPACT_ENTRIES,
										leading: impactDot(h, form.impact),
										onInput: (value) =>
											Message.ChangedIncidentEditField({ field: "impact", value }),
									}),
								]
							: []),
						...timeFields(h, form, issues?.times ?? null, timeZone),
						componentChecklist(h, model, {
							checkedIds: form.componentIds,
							idPrefix: "status-page-incident-edit-component",
							onToggle: (componentId) => Message.ToggledIncidentEditComponent({ componentId }),
						}),
						...failureAlert(h, "Couldn't save the changes", model.incidentEditFailure),
					],
	})
}

/** The three incident dialogs; each renders only while open. */
export const incidentDialogs = (
	h: H,
	model: Model,
	page: V2StatusPage,
	time: TimeInputs,
): ReadonlyArray<Html> => [
	composeDialogView(h, model, page, time),
	updateDialogView(h, model, time),
	editDialogView(h, model, time.timeZone),
]
