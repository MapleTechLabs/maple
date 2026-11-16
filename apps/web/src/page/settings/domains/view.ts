import { cn } from "@maple/ui/lib/utils"
import { Array as Arr, String as Str } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import { badge } from "@maple/views/ui/display"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import * as Field from "@maple/views/ui/field"
import { field, type FieldIds, fieldDescription, fieldLabel, input } from "@maple/views/ui/field"
import { formDialog } from "@maple/views/ui/form-dialog"
import { icon } from "@maple/views/ui/icon"
import * as Menu from "@maple/views/ui/menu"
import { rowActionsMenu } from "@maple/views/ui/row-actions-menu"
import * as SelectView from "@maple/views/ui/select-view"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack } from "@maple/views/ui/stack"
import {
	table,
	tableBody,
	tableCell,
	tableHead,
	tableHeader,
	tableRow,
	truncatedTableCell,
} from "@maple/views/ui/table"
import { truncatedText } from "@maple/views/ui/truncated-text"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { noOrganization } from "../kit/account-skeleton"
import { settingsSection, settingsSections } from "../../kit/settings-section"
import { type ClerkEnrollment, type DomainRow, Message, type Model } from "./model"
import { ENROLLMENTS, enrollmentSelectFor, isOnDomain, normalizeDomain } from "./update"

type H = HtmlBuilder<Message>

const ENROLLMENT_LABELS = {
	automatic_invitation: "Invite automatically",
	automatic_suggestion: "Suggest joining",
	manual_invitation: "Invite only",
} as const satisfies Record<ClerkEnrollment, string>

const ENROLLMENT_ENTRIES: ReadonlyArray<SelectView.SelectEntry> = Arr.map(
	ENROLLMENTS,
	(mode): SelectView.SelectEntry => ({
		_tag: "Item",
		item: { value: mode, label: ENROLLMENT_LABELS[mode] },
	}),
)

/** Below `sm` the Status column goes: the Verify button or the select already says it. */
const COLUMN = { status: "hidden w-28 sm:table-cell", enrollment: "w-40 sm:w-48", actions: "w-12" } as const

export const description =
	"Claim the email domains your team uses. Anyone who signs up with a verified domain can join without waiting for an invite."

export const headerActions = Submodel.defineView<Model, Message, Readonly<{}>>((model, _inputs, h) =>
	model.hasOrganization !== true
		? h.empty
		: button(h, { size: "sm", attributes: [h.OnClick(Message.ClickedAdd())] }, [
				icon(h, "PlusIcon", { attributes: [h.DataAttribute("icon", "inline-start")] }),
				"Add domain",
			]),
)

const statusBadge = (h: H, row: DomainRow): Html =>
	row.isVerified
		? badge(h, { variant: "done" }, ["Verified"])
		: badge(h, { variant: "muted" }, ["Unverified"])

const enrollmentCell = (h: H, model: Model, row: DomainRow): Html => {
	if (!row.isVerified)
		return tableCell(h, [
			button(
				h,
				{
					variant: "outline",
					size: "sm",
					attributes: [h.OnClick(Message.ClickedVerify({ id: row.id }))],
				},
				["Verify"],
			),
		])
	return tableCell(h, [
		h.submodel({
			slotId: `domain-enrollment-${row.id}`,
			model: { ...enrollmentSelectFor(model, row), value: row.enrollment },
			view: SelectView.view,
			toParentMessage: (message) => Message.GotEnrollmentSelectMessage({ id: row.id, message }),
			viewInputs: {
				entries: ENROLLMENT_ENTRIES,
				ariaLabel: `Who joins from ${row.name}`,
				size: "sm",
				isDisabled: model.savingEnrollment.includes(row.id),
				className: "w-full min-w-0",
				renderValue: () => [ENROLLMENT_LABELS[row.enrollment]],
				toView: (parts) => h.div([h.Class("contents")], parts),
			},
		}),
	])
}

const domainRow = (h: H, model: Model, row: DomainRow): Html => {
	const menuId = `domain-actions-${row.id}`
	return tableRow(
		h,
		[
			truncatedTableCell(h, [
				hstack(h, { gap: "2" }, [
					icon(h, "GlobeIcon", { className: "size-3.5 shrink-0 text-muted-foreground" }),
					truncatedText(h, {
						text: row.name,
						className: typographyClass({ size: "xs", weight: "medium" }),
					}),
				]),
			]),
			tableCell(h, [statusBadge(h, row)], COLUMN.status),
			enrollmentCell(h, model, row),
			tableCell(h, [
				rowActionsMenu(h, {
					slotId: menuId,
					model: model.rowMenus[menuId] ?? Menu.init(menuId),
					label: `Actions for ${row.name}`,
					entries: [
						...(row.isVerified
							? []
							: [
									{
										_tag: "Item" as const,
										value: "verify",
										label: "Verify",
										icon: "CircleCheckIcon" as const,
									},
								]),
						{
							_tag: "Item",
							value: "remove",
							label: "Remove",
							icon: "TrashIcon",
							variant: "destructive",
						},
					],
					toParentMessage: (message) => Message.GotRowMenuMessage({ menuId, id: row.id, message }),
				}),
			]),
		],
		undefined,
		[h.Key(row.id)],
	)
}

const skeletonRow = (h: H, index: number): Html =>
	tableRow(
		h,
		[
			tableCell(h, [skeleton(h, "h-3 w-40")]),
			tableCell(h, [skeleton(h, "h-4 w-16")], COLUMN.status),
			tableCell(h, [skeleton(h, "h-7 w-full")]),
			tableCell(h, []),
		],
		undefined,
		[h.Key(`skeleton-${index}`)],
	)

const domainsTable = (h: H, rows: ReadonlyArray<Html>): Html =>
	table(h, { className: "table-fixed" }, [
		tableHeader(h, [
			tableRow(h, [
				tableHead(h, ["Domain"]),
				tableHead(h, ["Status"], COLUMN.status),
				tableHead(h, ["New people"], COLUMN.enrollment),
				tableHead(h, [], COLUMN.actions),
			]),
		]),
		tableBody(h, rows),
	])

const noDomains = (h: H): Html =>
	empty(h, [
		emptyHeader(h, [
			emptyMedia(h, {}, [icon(h, "GlobeIcon", { size: 20 })]),
			emptyTitle(h, ["No domains yet"]),
			emptyDescription(h, [
				"Add a domain like acme.com and confirm it with a code sent to an address on it.",
			]),
		]),
		button(h, { size: "sm", attributes: [h.OnClick(Message.ClickedAdd())] }, ["Add domain"]),
	])

const domainsSection = (h: H, model: Model): Html =>
	settingsSection(h, { id: "settings-domains", title: "Verified domains", isLead: true, padded: false }, [
		AsyncData.matchDataSplitEmpty(model.domains, {
			onIdle: () =>
				domainsTable(
					h,
					Arr.map([0, 1], (index) => skeletonRow(h, index)),
				),
			onLoading: () =>
				domainsTable(
					h,
					Arr.map([0, 1], (index) => skeletonRow(h, index)),
				),
			onFailure: (failure) =>
				errorState(h, {
					failure,
					title: "Couldn't load domains",
					variant: "row",
					onRetry: Message.ClickedRetry(),
				}),
			onData: (rows) =>
				rows.length === 0
					? noDomains(h)
					: domainsTable(
							h,
							Arr.map(rows, (row) => domainRow(h, model, row)),
						),
		}),
	])

const DOMAIN_IDS: FieldIds = {
	control: "domain-name",
	label: "domain-name-label",
	error: "domain-name-error",
}
const EMAIL_IDS: FieldIds = {
	control: "domain-email",
	label: "domain-email-label",
	error: "domain-email-error",
	description: "domain-email-hint",
}
const CODE_IDS: FieldIds = { control: "domain-code", label: "domain-code-label", error: "domain-code-error" }

const addDialog = (h: H, model: Model): Html => {
	const state = Field.stateOf(model.domainField, false)
	return formDialog(h, {
		slotId: "domain-add",
		model: model.addDialog,
		toParentMessage: (message) => Message.GotAddDialogMessage({ message }),
		title: "Add domain",
		description: "Next you'll confirm it with a code sent to an address on the domain.",
		onSubmit: Message.SubmittedAdd(),
		submitLabel: "Add domain",
		isPending: model.isAdding,
		isSubmitDisabled: normalizeDomain(model.domainField.value).length === 0,
		fields: [
			field(h, { state }, [
				fieldLabel(h, { ids: DOMAIN_IDS, state }, "Domain"),
				input(h, {
					ids: DOMAIN_IDS,
					state,
					attributes: [
						h.Placeholder("acme.com"),
						h.Autocomplete("off"),
						...Field.controlAttributes(h, model.domainField, (message) =>
							Message.GotDomainFieldMessage({ message }),
						),
					],
				}),
			]),
		],
	})
}

const verifyDialog = (h: H, model: Model): Html => {
	const verifying = model.verifying
	const name = verifying?.name ?? ""
	const isCode = verifying?.step === "code"
	const emailState = Field.stateOf(model.emailField, false)
	const codeState = Field.stateOf(model.codeField, false)
	const isEmailWrong =
		Str.trim(model.emailField.value).length > 0 && !isOnDomain(model.emailField.value, name)
	return formDialog(h, {
		slotId: "domain-verify",
		model: model.verifyDialog,
		toParentMessage: (message) => Message.GotVerifyDialogMessage({ message }),
		title: `Verify ${name}`,
		description: isCode
			? `Enter the code sent to ${verifying?.email ?? ""}.`
			: `We'll email a code to an address on ${name} to prove your team owns it.`,
		onSubmit: Message.SubmittedVerify(),
		submitLabel: isCode ? "Verify" : "Send code",
		isPending: model.isVerifyPending,
		isSubmitDisabled: isCode
			? Str.trim(model.codeField.value).length === 0
			: !isOnDomain(model.emailField.value, name),
		...(isCode && {
			footerStart: hstack(h, { gap: "1" }, [
				button(
					h,
					{
						variant: "ghost",
						size: "sm",
						isDisabled: model.isVerifyPending,
						attributes: [h.OnClick(Message.ClickedResendCode())],
					},
					["Resend code"],
				),
				button(
					h,
					{
						variant: "ghost",
						size: "sm",
						isDisabled: model.isVerifyPending,
						attributes: [h.OnClick(Message.ClickedChangeEmail())],
					},
					["Use another address"],
				),
			]),
		}),
		fields: isCode
			? [
					field(h, { state: codeState }, [
						fieldLabel(h, { ids: CODE_IDS, state: codeState }, "Code"),
						input(h, {
							ids: CODE_IDS,
							state: codeState,
							attributes: [
								h.Placeholder("123456"),
								h.Autocomplete("one-time-code"),
								h.InputMode("numeric"),
								h.Maxlength(6),
								...Field.controlAttributes(h, model.codeField, (message) =>
									Message.GotCodeFieldMessage({ message }),
								),
							],
						}),
					]),
				]
			: [
					field(h, { state: { ...emailState, isInvalid: isEmailWrong } }, [
						fieldLabel(h, { ids: EMAIL_IDS, state: emailState }, "Email address"),
						input(h, {
							ids: EMAIL_IDS,
							state: { ...emailState, isInvalid: isEmailWrong },
							attributes: [
								h.Type("email"),
								h.Placeholder(`you@${name}`),
								...Field.controlAttributes(h, model.emailField, (message) =>
									Message.GotEmailFieldMessage({ message }),
								),
							],
						}),
						fieldDescription(
							h,
							{
								ids: EMAIL_IDS,
								state: emailState,
								className: cn(isEmailWrong && "text-destructive"),
							},
							isEmailWrong
								? `Use an address that ends in @${name}.`
								: "Any inbox on the domain works.",
						),
					]),
				],
	})
}

const dialogs = (h: H, model: Model): ReadonlyArray<Html> => [
	addDialog(h, model),
	verifyDialog(h, model),
	confirmDialog(h, {
		slotId: "domain-remove",
		model: model.removeDialog,
		toParentMessage: (message) => Message.GotRemoveDialogMessage({ message }),
		title: `Remove ${model.removing?.name ?? "domain"}?`,
		description:
			"People from this domain will need an invite to join. Members who already joined keep their access.",
		confirmLabel: "Remove domain",
		isPending: model.isRemoving,
		onConfirm: Message.ClickedConfirmRemove(),
	}),
]

const footnote = (h: H): Html =>
	typography(h, { size: "xs", tone: "muted", as: "p", className: "font-prose" }, [
		"People invited automatically join with the organization's default role. Public email providers like gmail.com can't be added.",
	])

export const view = Submodel.defineView<Model, Message, Readonly<{}>>((model, _inputs, h) =>
	model.hasOrganization === false
		? noOrganization(h, "Select or create an organization to manage its domains.")
		: settingsSections(h, [domainsSection(h, model), footnote(h), ...dialogs(h, model)]),
)
