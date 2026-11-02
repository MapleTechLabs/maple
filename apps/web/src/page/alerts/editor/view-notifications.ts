import { ALERT_TEMPLATE_VARIABLES } from "@maple/domain/http"
import { comparatorSupportsTiers } from "@maple/web-data/alerts/form-utils"
import { Struct } from "effect"
import { createLazy, type Html, type HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { card } from "@maple/views/ui/card"
import { badge } from "@maple/views/ui/display"
import { field, fieldLabel, input } from "@maple/views/ui/field"
import { icon } from "@maple/views/ui/icon"
import { inlineCode } from "@maple/views/ui/inline-code"
import { statusDot } from "@maple/views/ui/status-dot"
import { pressable } from "@maple/views/ui/pressable"
import { textarea } from "@maple/views/ui/textarea"
import { stableSlice } from "../../kit/stable-slice"
import { destinationsOf } from "./derive-rows"
import type { RuleForm } from "./form"
import { Message } from "./message"
import type { Model } from "./model"
import { fieldStateOf, idsOf } from "./view-fields"
import { destinationList, type NotifyView } from "./view-notify"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"

// `NotificationsSection`: who gets notified, per tier,
// and the optional message template.

type H = HtmlBuilder<Message>

/** What the section reads off the Model and the draft. */
type NotificationsView = NotifyView &
	Pick<Model, "destinations" | "isSendingTest" | "isMessageTemplateOpen" | "mountedForm">
type NotificationsForm = Pick<
	RuleForm,
	"comparator" | "escalation" | "destinationIds" | "notificationTitle" | "notificationBody"
>

const TITLE_PLACEHOLDER = "{{ event.emoji }} {{ rule.name }} — {{ event.label }}"
const BODY_PLACEHOLDER = [
	"{{ signal.label }} is *{{ value }}* ({{ comparator.label }} {{ threshold }}) over the last {{ window }}.",
	"*Severity:* {{ severity }} · *Group:* {{ group }}",
].join("\n")

const tierHeading = (h: H, severity: "warning" | "critical", text: string): Html =>
	h.p(
		[h.Class("flex items-center gap-1.5 text-xs font-medium text-muted-foreground")],
		[
			statusDot(h, {
				tone: "custom",
				className: severity === "critical" ? "bg-severity-error" : "bg-severity-warn",
			}),
			text,
		],
	)

/** `MessageTemplate`: collapsed until opened, or open when the rule has one. */
const messageTemplate = (h: H, model: NotificationsView, form: NotificationsForm): Html => {
	const hasTemplate = form.notificationTitle.length > 0 || form.notificationBody.length > 0
	const isOpen = model.isMessageTemplateOpen
	const titleState = fieldStateOf(form.notificationTitle, model.mountedForm?.notificationTitle)
	const bodyState = fieldStateOf(form.notificationBody, model.mountedForm?.notificationBody)
	const titleIds = idsOf("notification-title", false)
	const bodyIds = idsOf("notification-body", false)
	return h.div(
		[h.Class("mt-3")],
		[
			pressable(
				h,
				{
					onClick: Message.ToggledMessageTemplate(),
					className:
						"flex w-full items-center justify-between gap-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground active:text-foreground",
					attributes: [h.AriaExpanded(isOpen)],
				},
				[
					hstack(h, { gap: "1.5", as: "span" }, [
						icon(h, isOpen ? "ChevronDownIcon" : "ChevronRightIcon", { size: 12 }),
						"Message template",
					]),
					...(hasTemplate && !isOpen
						? [
								badge(
									h,
									{ pill: true, size: "xs", className: "bg-primary-a2 text-primary" },
									["Customized"],
								),
							]
						: []),
				],
			),
			...(isOpen
				? [
						h.div(
							[h.Class("mt-3 space-y-3")],
							[
								typography(h, { size: "xs", tone: "muted", as: "p" }, [
									"Customize the Slack / Discord / PagerDuty message. Leave blank to use Maple's default format. Supports ",
									inlineCode(h, {}, ["{{ variable }}"]),
									" substitution.",
								]),
								field(h, { className: "items-stretch gap-1.5", state: titleState }, [
									fieldLabel(h, { ids: titleIds, state: titleState }, "Title"),
									input(h, {
										ids: titleIds,
										state: titleState,
										attributes: [
											h.Placeholder(TITLE_PLACEHOLDER),
											h.Value(form.notificationTitle),
											h.OnInput((value) =>
												Message.ChangedField({ field: "notificationTitle", value }),
											),
										],
									}),
								]),
								field(h, { className: "items-stretch gap-1.5", state: bodyState }, [
									fieldLabel(h, { ids: bodyIds, state: bodyState }, "Body (Markdown)"),
									textarea(h, {
										id: "notification-body",
										className: typographyClass({ size: "xs", mono: true }),
										defaultValue: form.notificationBody,
										attributes: [
											h.AriaLabelledBy(bodyIds.label),
											h.Placeholder(BODY_PLACEHOLDER),
											h.Rows(4),
											h.OnInput((value) =>
												Message.ChangedField({ field: "notificationBody", value }),
											),
										],
									}),
								]),
								variables(h),
							],
						),
					]
				: []),
		],
	)
}

const notifications = (h: H, model: NotificationsView, form: NotificationsForm): Html => {
	const destinations = destinationsOf(model)
	const escalation = comparatorSupportsTiers(form.comparator) ? form.escalation : null
	const isAnySelected = destinations.some(
		(d) => form.destinationIds.includes(d.id) || (escalation?.destinationIds.includes(d.id) ?? false),
	)
	return card(
		h,
		[
			...(isAnySelected
				? [
						// TODO(alert-editor): the "Send a real test notification…" tooltip.
						h.div(
							[h.Class("-mt-1 flex justify-end")],
							[
								button(
									h,
									{
										variant: "ghost",
										size: "sm",
										isLoading: model.isSendingTest,
										className: "-my-1 px-2 text-xs",
										attributes: [h.OnClick(Message.ClickedSendTest())],
									},
									[icon(h, "PaperPlaneIcon", { size: 12 }), "Send test"],
								),
							],
						),
					]
				: []),
			...(escalation === null
				? [destinationList(h, model, "warning", form.destinationIds, destinations)]
				: [
						h.div(
							[h.Class("mt-1 space-y-4")],
							[
								h.div(
									[h.Class("space-y-1.5")],
									[
										tierHeading(h, "warning", "Warning"),
										destinationList(
											h,
											model,
											"warning",
											form.destinationIds,
											destinations,
										),
									],
								),
								h.div(
									[h.Class("space-y-1.5")],
									[
										tierHeading(
											h,
											"critical",
											"Critical, on top of the warning destinations",
										),
										destinationList(
											h,
											model,
											"critical",
											escalation.destinationIds,
											destinations,
										),
									],
								),
							],
						),
					]),
			messageTemplate(h, model, form),
		],
		"p-4",
	)
}

/** "Insert a variable": one button per template variable. TODO(alert-editor): their description tooltips. */
const variables = (h: H): Html =>
	h.div(
		[h.Class("space-y-1.5")],
		[
			typography(h, { size: "xs", tone: "muted" }, ["Insert a variable:"]),
			hstack(
				h,
				{ gap: "1", align: "stretch", wrap: true },
				ALERT_TEMPLATE_VARIABLES.map((variable) =>
					button(
						h,
						{
							variant: "outline",
							size: "xs",
							className:
								"font-mono text-3xs text-muted-foreground hover:text-foreground active:text-foreground sm:text-3xs",
							attributes: [h.OnClick(Message.ClickedTemplateVariable({ key: variable.key }))],
						},
						[variable.key],
					),
				),
			),
		],
	)

// Rebuilt on its own fields and the draft's delivery fields only: typing a name skips it.
const slot = createLazy()
const viewOf = stableSlice((model: Model) =>
	Struct.pick(model, [
		"destinations",
		"isSendingTest",
		"isMessageTemplateOpen",
		"mountedForm",
		"isAdmin",
		"connectors",
		"menus",
		"chatConnect",
		"chatConnectMenuId",
		"brokenLogos",
	]),
)
const formOf = stableSlice((form: RuleForm) =>
	Struct.pick(form, [
		"comparator",
		"escalation",
		"destinationIds",
		"notificationTitle",
		"notificationBody",
	]),
)

/** "Who gets notified": one list per tier, Send test while anything is selected, and the template. */
export const notificationsSection = (h: H, model: Model, form: RuleForm): Html =>
	slot(notifications, [h, viewOf(model), formOf(form)])
