import { MAPLE_REGION_LABELS } from "@maple/domain/organization-regions"
import { initialsFrom } from "@maple/ui/lib/initials"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { confirmDialog } from "../../../ui/confirm-dialog"
import { warmAvatarTone } from "../../../ui/avatar-tone"
import { avatarFallback, badge } from "../../../ui/display"
import { input } from "../../../ui/input"
import { label } from "../../../ui/label"
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
					h.div(
						[h.Class("p-4")],
						[
							imageDropzone(h, {
								inputId: LOGO_INPUT_ID,
								title: "Logo",
								hint: model.isAdmin
									? "Saved as soon as you upload. PNG, JPG, WEBP or GIF, up to 10 MB."
									: null,
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
					h.div(
						[h.Class("flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:gap-4")],
						[
							h.div(
								[h.Class("flex shrink-0 flex-col gap-1 sm:w-60 sm:pt-1.5")],
								[
									label(
										h,
										{ className: "text-sm font-medium", attributes: [h.For("org-name")] },
										["Name"],
									),
									h.p(
										[h.Class("font-prose text-xs text-muted-foreground")],
										["Shown in the organization switcher."],
									),
								],
							),
							model.isAdmin
								? input(h, {
										id: "org-name",
										className: "flex-1",
										isDisabled: model.isSavingName,
										attributes: [
											h.Value(nameDraftOf(model)),
											h.OnInput((value) => Message.ChangedName({ value })),
											h.Maxlength(100),
											h.Placeholder("Organization name"),
										],
									})
								: h.p(
										[
											h.Id("org-name"),
											h.Class("flex-1 text-sm text-foreground sm:pt-1.5"),
										],
										[org.name],
									),
						],
					),
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
		},
		[
			h.div(
				[h.Class("flex items-center justify-between gap-4")],
				[
					h.div(
						[h.Class("flex items-center gap-2 text-sm")],
						[
							badge(
								h,
								{
									variant: "meta",
									size: "xs",
									mono: true,
									attributes: [h.Title(`Data region: ${region.name}`)],
								},
								[region.short],
							),
							h.span([], [region.name]),
						],
					),
					h.p(
						[h.Class("font-prose text-xs text-muted-foreground")],
						["Set when the organization was created. It cannot be changed."],
					),
				],
			),
		],
	)
}

const dangerZone = (h: H, model: Model, org: OrgInfo): Html => {
	const leave = leaveEligibilityOf(model)
	return settingsSection(h, { id: "settings-general-danger", title: "Danger zone", framed: false }, [
		panel(h, { className: "divide-y border-destructive/40" }, [
			h.div(
				[h.Class("flex items-center justify-between gap-4 p-4")],
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
					button(
						h,
						{
							variant: "outline",
							size: "sm",
							isDisabled: leave !== "allowed",
							attributes: [h.OnClick(Message.ClickedLeave())],
						},
						["Leave organization"],
					),
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

const loaded = (h: H, model: Model, org: OrgInfo): Html =>
	settingsSections(h, [
		...adminOnlyNotice(h, {
			isAdmin: model.isAdmin,
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

export const view = Submodel.defineView<Model, Message, Readonly<Record<never, never>>>((model, _inputs, h) =>
	AsyncData.matchDataSplitEmpty(model.org, {
		onIdle: () => accountSectionSkeleton(h),
		onLoading: () => accountSectionSkeleton(h),
		onFailure: () => noOrganization(h, NO_ORG),
		onData: (org) => (org === null ? noOrganization(h, NO_ORG) : loaded(h, model, org)),
	}),
)
