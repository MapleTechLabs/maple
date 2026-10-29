import { MAPLE_REGION_LABELS } from "@maple/domain/organization-regions"
import { initialsFrom } from "@maple/ui/lib/initials"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { confirmDialog } from "../../../ui/confirm-dialog"
import { warmAvatarTone } from "../../../ui/avatar-tone"
import { avatarFallback } from "../../../ui/display"
import { input } from "../../../ui/input"
import { settingRow } from "../../../ui/setting-row"
import { panel } from "../../../ui/panel"
import { accountSectionSkeleton, noOrganization } from "../kit/account-skeleton"
import { imageDropzone, typeToConfirmField } from "../kit/image-dropzone"
import { adminOnlyNotice } from "../kit/members"
import { saveBar } from "../kit/save-bar"
import { settingsSection, settingsSections } from "../kit/section"
import { Message, type Model, type OrgInfo } from "./model"
import { isNameDirty, LOGO_INPUT_ID, leaveEligibilityOf, nameDraftOf } from "./update"

type H = HtmlBuilder<Message>

const NO_ORG = "Select or create an organization to manage its settings."

/** What deleting an organization does, checked against `OrganizationService.delete`. */
const DELETION_FACTS = [
	{
		key: "Deleted",
		value: "Dashboards and share links, alert rules and destinations, API and ingest keys, MCP connections, integrations, error issues, scrape targets, code reviews and the data platform connection.",
		isDestructive: true,
	},
	{ key: "Ages out", value: "Telemetry already sent, under its retention.", isDestructive: false },
	{
		key: "Kept",
		value: "The audit log, billing records, and some history and settings: investigations, anomaly history, AI triage and escalation settings, attribute mappings and sampling.",
		isDestructive: false,
	},
] as const

const deletionFacts = (h: H): Html =>
	h.dl(
		[h.Class("flex flex-col gap-1 text-xs")],
		DELETION_FACTS.map((fact) =>
			h.div(
				[h.Key(fact.key), h.Class("flex gap-2")],
				[
					h.dt(
						[
							h.Class(
								fact.isDestructive
									? "w-16 shrink-0 text-destructive"
									: "w-16 shrink-0 text-muted-foreground",
							),
						],
						[fact.key],
					),
					h.dd([h.Class("font-prose text-foreground")], [fact.value]),
				],
			),
		),
	)

/** `OrgAvatar fit="contain"`: the logo preview (the initials until images are rendered). */
const orgAvatar = (h: H, name: string): Html =>
	avatarFallback(
		h,
		{
			className: "size-8 rounded-md bg-transparent size-full",
			fallbackClassName: `rounded-[inherit] text-xs font-semibold ${warmAvatarTone(name)}`,
		},
		initialsFrom(name),
	)

/** Every General row: label and hint on the left, the value or control on the right. */
const row = (h: H, id: string, label: string, hint: string, control: ReadonlyArray<Html>): Html =>
	settingRow(h, {
		ids: { control: id, label: `${id}-label`, description: `${id}-hint` },
		label,
		description: hint,
		control,
		className: "p-4",
	})

const organizationSection = (h: H, model: Model, org: OrgInfo): Html =>
	settingsSection(
		h,
		{
			id: "settings-general-organization",
			title: "Organization",
			description: ["Logo and name are visible to every member."],
			padded: false,
		},
		[
			h.div(
				[h.Class("divide-y")],
				[
					row(
						h,
						LOGO_INPUT_ID,
						"Logo",
						model.isAdmin
							? "Saved as soon as you upload. PNG, JPG, WEBP or GIF, up to 10 MB."
							: "Shown beside the name in the organization switcher.",
						[
							imageDropzone(h, {
								inputId: LOGO_INPUT_ID,
								hint: null,
								preview: orgAvatar(h, org.name),
								isUploading: model.isSavingLogo,
								isDragging: model.isDragging,
								isReadOnly: !model.isAdmin,
								targetLabel: "Change organization logo",
								changeLabel: "Change logo",
								onPick: Message.ClickedPickLogo(),
								onFiles: (files) => Message.PickedLogo({ files }),
								onDragOver: Message.DraggedOverLogo(),
								onDragLeave: Message.LeftLogo(),
								...(org.hasImage && { onRemove: Message.ClickedRemoveLogo() }),
							}),
						],
					),
					row(h, "org-name", "Name", "Shown in the organization switcher.", [
						model.isAdmin
							? input(h, {
									id: "org-name",
									className: "w-72",
									isDisabled: model.isSavingName,
									attributes: [
										h.Value(nameDraftOf(model)),
										h.OnInput((value) => Message.ChangedName({ value })),
										h.Maxlength(100),
										h.Placeholder("Organization name"),
									],
								})
							: h.p([h.Id("org-name"), h.Class("text-sm text-foreground")], [org.name]),
					]),
				],
			),
		],
	)

const dataRegionSection = (h: H, org: OrgInfo): Html => {
	const region = MAPLE_REGION_LABELS[org.region]
	return settingsSection(
		h,
		{
			id: "settings-general-region",
			title: "Data region",
			description: ["Where this organization's telemetry is stored and processed."],
			padded: false,
		},
		[
			row(h, "org-region", "Region", "Set when the organization was created. It cannot be changed.", [
				// The full name alone: a short code chip before it repeated the name at low contrast.
				h.span(
					[h.Id("org-region"), h.Class("text-sm"), h.Title(`Data region: ${region.name}`)],
					[region.name],
				),
			]),
		],
	)
}

const dangerZone = (h: H, model: Model, org: OrgInfo): Html => {
	const leave = leaveEligibilityOf(model)
	return settingsSection(h, { id: "settings-general-danger", title: "Danger zone", framed: false }, [
		panel(h, { className: "divide-y border-destructive/40" }, [
			h.div(
				// Top-aligned like the delete row below, whose consequence list runs longer.
				[h.Class("flex items-start justify-between gap-6 p-4")],
				[
					h.div(
						[h.Class("space-y-1")],
						[
							h.p([h.Class("text-sm font-medium text-foreground")], ["Leave organization"]),
							h.p(
								[h.Class("font-prose text-xs text-muted-foreground")],
								[
									leave === "last-admin"
										? "You are the only admin. Make another member an admin before you leave."
										: "You lose access until someone invites you again.",
								],
							),
						],
					),
					// A disabled button fires no hover, so its wrapper carries the reason as a tooltip.
					h.span(leave === "last-admin" ? [h.Title("Make another member an admin first")] : [], [
						button(
							h,
							{
								// Disabled reads neutral, so dim red text never passes for an active action.
								variant: leave === "allowed" ? "destructive-outline" : "outline",
								size: "sm",
								isDisabled: leave !== "allowed",
								attributes: [h.OnClick(Message.ClickedLeave())],
							},
							["Leave organization"],
						),
					]),
				],
			),
			...(model.isAdmin
				? [
						h.div(
							[h.Class("flex items-start justify-between gap-6 p-4")],
							[
								h.div(
									[h.Class("flex flex-1 flex-col gap-2")],
									[
										h.p(
											[h.Class("text-sm font-medium text-foreground")],
											["Delete organization"],
										),
										h.p(
											[h.Class("font-prose text-xs text-muted-foreground")],
											[
												'Permanently deletes "',
												org.name,
												`" and removes every member's access. This cannot be undone.`,
											],
										),
										deletionFacts(h),
									],
								),
								button(
									h,
									{
										variant: "destructive",
										size: "sm",
										attributes: [h.OnClick(Message.ClickedDelete())],
									},
									["Delete organization"],
								),
							],
						),
					]
				: []),
		]),
	])
}

const dialogs = (h: H, model: Model, org: OrgInfo): ReadonlyArray<Html> => [
	confirmDialog(h, {
		slotId: "org-leave",
		model: model.leaveDialog,
		toParentMessage: (message) => Message.GotLeaveDialogMessage({ message }),
		title: `Leave ${org.name}?`,
		description:
			"You lose access to its dashboards, alerts and settings until someone invites you again.",
		confirmLabel: "Leave organization",
		isPending: model.isLeaving,
		onConfirm: Message.ClickedConfirmLeave(),
	}),
	confirmDialog(h, {
		slotId: "org-delete",
		model: model.deleteDialog,
		toParentMessage: (message) => Message.GotDeleteDialogMessage({ message }),
		title: "Delete organization?",
		description: `Permanently deletes "${org.name}" and removes every member's access. This cannot be undone.`,
		confirmLabel: "Delete organization",
		isPending: model.isDeleting,
		isConfirmDisabled: model.confirmText.trim() !== org.name,
		onConfirm: Message.ClickedConfirmDelete(),
		children: [
			h.div(
				[h.Class("space-y-4")],
				[
					deletionFacts(h),
					typeToConfirmField(h, {
						id: "org-delete-confirm",
						expected: org.name,
						value: model.confirmText,
						onInput: (value) => Message.ChangedConfirmText({ value }),
					}),
				],
			),
		],
	}),
]

const loaded = (h: H, model: Model, org: OrgInfo, isKnownMember: boolean): Html =>
	settingsSections(h, [
		...adminOnlyNotice(h, {
			isKnownMember: isKnownMember && !model.isAdmin,
			subject: "organization settings",
			adminName: AsyncData.getOrElse(
				AsyncData.map(model.admins, (admins) => admins.firstAdminName),
				() => null,
			),
		}),
		organizationSection(h, model, org),
		dataRegionSection(h, org),
		dangerZone(h, model, org),
		...saveBar(h, {
			isDirty: isNameDirty(model),
			isPending: model.isSavingName,
			isSaveDisabled: nameDraftOf(model).trim().length === 0,
			onDiscard: Message.ClickedDiscardName(),
			onSave: Message.ClickedSaveName(),
		}),
		...dialogs(h, model, org),
	])

export const view = Submodel.defineView<Model, Message, Readonly<{ isKnownMember: boolean }>>(
	(model, inputs, h) =>
		AsyncData.matchDataSplitEmpty(model.org, {
			onIdle: () => accountSectionSkeleton(h),
			onLoading: () => accountSectionSkeleton(h),
			onFailure: () => noOrganization(h, NO_ORG),
			onData: (org) =>
				org === null ? noOrganization(h, NO_ORG) : loaded(h, model, org, inputs.isKnownMember),
		}),
)
