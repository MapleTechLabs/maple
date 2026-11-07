import { ALERT_TEMPLATE_VARIABLES, type AlertDestinationId, type EscalationChainId } from "@maple/domain/http"
import { comparatorSupportsTiers } from "@maple/web-data/alerts/form-utils"
import { Option, Struct, Array as Arr } from "effect"
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
import { hstack, vstack } from "@maple/views/ui/stack"
import { textLink } from "@maple/views/ui/text-link"
import { chainSummary, routingTabHref } from "../shared/escalation-chains"
import { chainSelectIdOf, NO_CHAIN } from "./form-steps"
import type { Tier } from "./message"
import { formSelect } from "./view-select"

// `NotificationsSection`: who gets notified, per tier,
// and the optional message template.

type H = HtmlBuilder<Message>

/** What the section reads off the Model and the draft. */
type NotificationsView = NotifyView &
	Pick<
		Model,
		| "destinations"
		| "isSendingTest"
		| "isMessageTemplateOpen"
		| "mountedForm"
		| "escalationChains"
		| "isEscalationChainsFailed"
		| "selects"
	>
type NotificationsForm = Pick<
	RuleForm,
	| "signalType"
	| "comparator"
	| "escalation"
	| "destinationIds"
	| "escalationChainId"
	| "notificationTitle"
	| "notificationBody"
>

const TITLE_PLACEHOLDER = "{{ event.emoji }} {{ rule.name }} — {{ event.label }}"
const BODY_PLACEHOLDER = Arr.join(
	[
		"{{ signal.label }} is *{{ value }}* ({{ comparator.label }} {{ threshold }}) over the last {{ window }}.",
		"*Severity:* {{ severity }} · *Group:* {{ group }}",
	],
	"\n",
)

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

/** The chain select's options: None, the org's chains, and a saved one the list no longer has. */
const chainOptions = (model: NotificationsView, chainId: EscalationChainId | null) => {
	const chains = model.escalationChains ?? []
	const isMissing = chainId !== null && !Arr.some(chains, (chain) => chain.id === chainId)
	return [
		{ value: NO_CHAIN, label: "None" },
		...(isMissing
			? [
					{
						value: chainId,
						label: model.escalationChains === null ? "Saved chain" : "Unavailable chain",
					},
				]
			: []),
		...Arr.map(chains, (chain) => ({ value: chain.id, label: chain.name })),
	]
}

/** `TierChainPicker`: the escalation chain a tier starts on top of its destinations. */
const chainPicker = (
	h: H,
	model: NotificationsView,
	tier: Tier,
	chainId: EscalationChainId | null,
	destinationIds: ReadonlyArray<AlertDestinationId>,
	label: string,
	/** Each tier needs its own route; an anomaly rule only needs someone on either tier. */
	isRouteRequired: boolean,
): Html => {
	const id = chainSelectIdOf(tier)
	const ids = idsOf(id, false)
	const value = chainId ?? NO_CHAIN
	const state = fieldStateOf(value, undefined)
	const destinations = destinationsOf(model)
	const nameOf = (destinationId: AlertDestinationId) =>
		Option.getOrElse(
			Option.map(
				Arr.findFirst(destinations, (destination) => destination.id === destinationId),
				(destination) => destination.name,
			),
			() => "an unavailable destination",
		)
	const selected = Arr.findFirst(model.escalationChains ?? [], (chain) => chain.id === chainId)
	const note = Option.match(selected, {
		onSome: (chain) => [
			typography(h, { size: "xs", tone: "muted", as: "p", className: "break-words" }, [
				chainSummary(chain, nameOf),
			]),
		],
		onNone: () => [
			...(model.isEscalationChainsFailed
				? [
						typography(h, { size: "xs", tone: "muted", as: "p" }, [
							chainId === null
								? "Couldn't load escalation chains; reload the page to pick one"
								: "Couldn't load escalation chains; reload the page to change this one",
						]),
					]
				: []),
			...(isRouteRequired && chainId === null && destinationIds.length === 0
				? [
						typography(h, { size: "xs", tone: "destructive", as: "p" }, [
							"Pick a destination or an escalation chain",
						]),
					]
				: []),
		],
	})
	return formSelect(h, model.selects[id], id, value, chainOptions(model, chainId), {
		className: "h-9 w-full",
		labelledBy: ids.label,
		toView: (parts) =>
			field(h, { className: "items-stretch gap-1.5", state }, [
				hstack(h, { gap: "2", justify: "between" }, [
					fieldLabel(h, { ids, state, className: "text-xs" }, label),
					textLink(
						h,
						{
							href: routingTabHref(),
							tone: "muted",
							className: "text-xs",
							attributes: [h.Target("_blank"), h.Rel("noopener")],
						},
						["Create a chain"],
					),
				]),
				...parts,
				...note,
			]),
	})
}

/** One tier's destinations, then the chain it starts; `tiered` names the picker by its tier. */
const tierRouting = (
	h: H,
	model: NotificationsView,
	tier: Tier,
	destinationIds: ReadonlyArray<AlertDestinationId>,
	chainId: EscalationChainId | null,
	tiered: boolean,
	isRouteRequired: boolean,
): Html =>
	vstack(h, { gap: "3" }, [
		destinationList(h, model, tier, destinationIds, destinationsOf(model)),
		chainPicker(
			h,
			model,
			tier,
			chainId,
			destinationIds,
			// Two tiers render two pickers, so each needs its own accessible name.
			tiered ? `${tier === "warning" ? "Warning" : "Critical"} escalation chain` : "Escalation chain",
			isRouteRequired,
		),
	])

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
	const isRouteRequired = form.signalType !== "anomaly"
	const isAnySelected = Arr.some(
		destinations,
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
				? [
						tierRouting(
							h,
							model,
							"warning",
							form.destinationIds,
							form.escalationChainId,
							false,
							isRouteRequired,
						),
					]
				: [
						h.div(
							[h.Class("mt-1 space-y-4")],
							[
								...(form.signalType === "anomaly"
									? [
											typography(h, { size: "xs", tone: "muted", as: "p" }, [
												"Maple rates each anomaly warning or critical by how far it strays from its baseline.",
											]),
										]
									: []),
								h.div(
									[h.Class("space-y-1.5")],
									[
										tierHeading(h, "warning", "Warning"),
										tierRouting(
											h,
											model,
											"warning",
											form.destinationIds,
											form.escalationChainId,
											true,
											isRouteRequired,
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
										tierRouting(
											h,
											model,
											"critical",
											escalation.destinationIds,
											escalation.escalationChainId,
											true,
											isRouteRequired,
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
				Arr.map(ALERT_TEMPLATE_VARIABLES, (variable) =>
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
		"grants",
		"connectors",
		"menus",
		"chatConnect",
		"chatConnectMenuId",
		"brokenLogos",
		"escalationChains",
		"isEscalationChainsFailed",
		"selects",
	]),
)
const formOf = stableSlice((form: RuleForm) =>
	Struct.pick(form, [
		"signalType",
		"comparator",
		"escalation",
		"destinationIds",
		"escalationChainId",
		"notificationTitle",
		"notificationBody",
	]),
)

/** "Who gets notified": one list per tier, Send test while anything is selected, and the template. */
export const notificationsSection = (h: H, model: Model, form: RuleForm): Html =>
	slot(notifications, [h, viewOf(model), formOf(form)])
