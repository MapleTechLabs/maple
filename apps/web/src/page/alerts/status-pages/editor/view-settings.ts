import type { V2StatusPage } from "@maple/domain/http/v2"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "../../../../ui/alert"
import { button } from "../../../../ui/button"
import { confirmDialog } from "../../../../ui/confirm-dialog"
import { copyableField } from "../../../../ui/copyable-field"
import { icon } from "../../../../ui/icon"
import { panel } from "../../../../ui/panel"
import { failureMessage } from "../../../../data/load-failure"
import { saveBar } from "../../../settings/kit/save-bar"
import { adminOnlyNote, settingsSection, settingsSections } from "../../../settings/kit/section"
import { switchRow } from "../../../settings/kit/switch-row"
import { publicPath } from "../../shared/status-page-commands"
import { selectField, textareaField, textField } from "../fields"
import { type SettingsForm, settingsFormOf, settingsIssues } from "./form"
import { Message } from "./message"
import type { Model } from "./model"
import { isSettingsDirty, settingsOf } from "./update-settings"

// The Settings tab: the page's fields, the break-glass token and deleting the page.

type H = HtmlBuilder<Message>

const AUTO_INCIDENT_ENTRIES = [
	{ value: "off", label: "Off" },
	{ value: "draft", label: "Open a draft for me to publish" },
	{ value: "publish", label: "Open and publish an incident" },
]

const pageSection = (h: H, model: Model, form: SettingsForm): Html => {
	const issues = settingsIssues(form)
	const isReadOnly = !model.isAdmin
	return settingsSection(
		h,
		{
			id: "status-page-settings-page",
			title: "Page",
			description: ["What visitors see at the top of the page."],
		},
		[
			h.div(
				[h.Class("grid gap-4 sm:grid-cols-2")],
				[
					textField(h, {
						id: "status-page-name",
						label: "Name",
						value: form.name,
						isDisabled: isReadOnly,
						error: issues.name,
						onInput: (value) => Message.ChangedSetting({ field: "name", value }),
					}),
					textField(h, {
						id: "status-page-slug",
						label: "Address",
						value: form.slug,
						isMono: true,
						isDisabled: isReadOnly,
						error: issues.slug,
						hint: `${publicPath(form.slug)}. Changing it moves the page; the old address stops working.`,
						onInput: (value) => Message.ChangedSetting({ field: "slug", value }),
					}),
					textareaField(h, {
						id: "status-page-description",
						label: "Description",
						value: form.description,
						isDisabled: isReadOnly,
						className: "sm:col-span-2",
						onInput: (value) => Message.ChangedSetting({ field: "description", value }),
					}),
					textField(h, {
						id: "status-page-website",
						label: "Website URL",
						value: form.websiteUrl,
						placeholder: "https://acme.example",
						isDisabled: isReadOnly,
						error: issues.websiteUrl,
						onInput: (value) => Message.ChangedSetting({ field: "websiteUrl", value }),
					}),
					textField(h, {
						id: "status-page-logo",
						label: "Logo URL",
						value: form.logoUrl,
						placeholder: "https://acme.example/logo.svg",
						isDisabled: isReadOnly,
						error: issues.logoUrl,
						onInput: (value) => Message.ChangedSetting({ field: "logoUrl", value }),
					}),
					h.div(
						[h.Class("flex items-end gap-2")],
						[
							textField(h, {
								id: "status-page-brand-color",
								label: "Brand color",
								value: form.brandColor,
								placeholder: "#1a2b3c",
								isMono: true,
								isDisabled: isReadOnly,
								error: issues.brandColor,
								className: "flex-1",
								onInput: (value) => Message.ChangedSetting({ field: "brandColor", value }),
							}),
							...(issues.brandColor === null && form.brandColor.trim() !== ""
								? [
										h.span(
											[
												h.AriaHidden(true),
												h.Class("mb-1.5 size-6 shrink-0 rounded-md border"),
												h.Style({ backgroundColor: form.brandColor.trim() }),
											],
											[],
										),
									]
								: []),
						],
					),
				],
			),
		],
	)
}

const behaviourSection = (h: H, model: Model, form: SettingsForm): Html =>
	settingsSection(h, { id: "status-page-settings-behaviour", title: "Behaviour", padded: false }, [
		h.div(
			[h.Class("divide-y")],
			[
				switchRow(h, {
					id: "status-page-powered-by",
					label: "Show powered by Maple",
					description: "A small credit in the page footer.",
					isChecked: form.showPoweredBy,
					isDisabled: !model.isAdmin,
					onToggle: Message.ToggledPoweredBy(),
					className: "p-4",
				}),
				h.div(
					[h.Class("p-4")],
					[
						selectField(h, {
							id: "status-page-auto-incidents",
							label: "When a linked monitor goes down",
							value: form.autoIncidents,
							entries: AUTO_INCIDENT_ENTRIES,
							isDisabled: !model.isAdmin,
							hint: "A draft waits for you on the Incidents tab; a published one shows on the page at once.",
							onInput: (value) => Message.ChangedSetting({ field: "autoIncidents", value }),
						}),
					],
				),
			],
		),
	])

const revealedToken = (h: H, model: Model): ReadonlyArray<Html> =>
	model.revealedToken === null
		? []
		: [
				h.div(
					[h.Class("flex flex-col gap-2 rounded-md border bg-muted/30 p-3")],
					[
						copyableField(h, {
							id: "status-page-break-glass-token",
							value: model.revealedToken.token,
							copyLabel: "break-glass token",
							copy: model.tokenCopy,
							toCopyMessage: (message) => Message.GotTokenCopyMessage({ message }),
						}),
						h.div(
							[h.Class("flex items-center justify-between gap-3")],
							[
								h.p(
									[h.Class("text-xs text-muted-foreground")],
									[
										"Store it outside Maple, in your password manager. It is not shown again.",
									],
								),
								button(
									h,
									{
										size: "sm",
										variant: "ghost",
										attributes: [h.OnClick(Message.ClickedDismissToken())],
									},
									["Done"],
								),
							],
						),
					],
				),
			]

const breakGlassSection = (h: H, model: Model, page: V2StatusPage): Html => {
	const suffix = page.break_glass_token_suffix
	return settingsSection(
		h,
		{
			id: "status-page-settings-break-glass",
			title: "Break-glass token",
			description: [
				"If Maple itself is down, post updates straight to the page with this token at ",
				h.code([h.Class("font-mono text-xs")], [`${publicPath(page.slug)}/_manage`]),
				". The page keeps serving from edge storage either way.",
			],
		},
		[
			h.div(
				[h.Class("flex flex-col gap-3")],
				[
					h.div(
						[h.Class("flex flex-wrap items-center justify-between gap-3")],
						[
							h.p(
								[h.Class("text-sm")],
								suffix === null
									? [h.span([h.Class("text-muted-foreground")], ["No token issued"])]
									: [
											"Active token ending in ",
											h.code([h.Class("font-mono text-xs")], [suffix]),
										],
							),
							...(model.isAdmin
								? [
										h.div(
											[h.Class("flex items-center gap-2")],
											[
												...(suffix === null
													? []
													: [
															button(
																h,
																{
																	size: "sm",
																	variant: "destructive-outline",
																	attributes: [
																		h.OnClick(
																			Message.ClickedRevokeToken(),
																		),
																	],
																},
																["Revoke"],
															),
														]),
												button(
													h,
													{
														size: "sm",
														variant: "outline",
														isLoading:
															model.isChangingBreakGlass &&
															model.breakGlassAction === "rotate",
														attributes: [h.OnClick(Message.ClickedRotateToken())],
													},
													[
														icon(h, "KeyIcon"),
														suffix === null ? "Issue token" : "Replace token",
													],
												),
											],
										),
									]
								: []),
						],
					),
					...revealedToken(h, model),
				],
			),
		],
	)
}

const dangerZone = (h: H): Html =>
	settingsSection(h, { id: "status-page-settings-danger", title: "Danger zone", framed: false }, [
		panel(h, { className: "border-destructive/40" }, [
			h.div(
				[h.Class("flex items-start justify-between gap-6 p-4")],
				[
					h.div(
						[h.Class("space-y-1")],
						[
							h.p([h.Class("text-sm font-medium text-foreground")], ["Delete status page"]),
							h.p(
								[h.Class("font-prose text-xs text-muted-foreground")],
								[
									"Takes the page offline and deletes its components and incidents. This cannot be undone.",
								],
							),
						],
					),
					button(
						h,
						{
							variant: "destructive",
							size: "sm",
							attributes: [h.OnClick(Message.ClickedDeletePage())],
						},
						["Delete status page"],
					),
				],
			),
		]),
	])

export const settingsTab = (h: H, model: Model, page: V2StatusPage): Html => {
	const form = Option.getOrElse(settingsOf(model), () => settingsFormOf(page))
	const issues = settingsIssues(form)
	const hasIssues = Object.values(issues).some((issue) => issue !== null)
	return h.div(
		[h.Class("flex max-w-4xl flex-col")],
		[
			settingsSections(h, [
				...(model.isAdmin
					? []
					: [
							adminOnlyNote(h, [
								"Only org admins can change a status page. You can still post incident updates.",
							]),
						]),
				pageSection(h, model, form),
				behaviourSection(h, model, form),
				breakGlassSection(h, model, page),
				...(model.isAdmin ? [dangerZone(h)] : []),
			]),
			...(model.settingsFailure === null
				? []
				: [
						alert(h, { variant: "crit", size: "sm", className: "mt-6" }, [
							icon(h, "CircleXmarkIcon"),
							alertTitle(h, ["Couldn't save the settings"]),
							alertDescription(h, [failureMessage(model.settingsFailure)]),
						]),
					]),
			...saveBar(h, {
				isDirty: isSettingsDirty(model),
				isPending: model.isSavingSettings,
				context: hasIssues ? "Fix the fields marked above." : undefined,
				onDiscard: Message.ClickedDiscardSettings(),
				onSave: Message.ClickedSaveSettings(),
				isSaveDisabled: hasIssues,
			}),
		],
	)
}

export const breakGlassDialog = (h: H, model: Model): Html =>
	confirmDialog(h, {
		slotId: "status-page-break-glass",
		model: model.breakGlassDialog,
		toParentMessage: (message) => Message.GotBreakGlassDialogMessage({ message }),
		title:
			model.breakGlassAction === "revoke"
				? "Revoke the break-glass token?"
				: "Replace the break-glass token?",
		description:
			model.breakGlassAction === "revoke"
				? "Updates posted with it are refused from now on. You can issue a new one later."
				: "The current token stops working at once. The new one is shown once.",
		confirmLabel: model.breakGlassAction === "revoke" ? "Revoke token" : "Replace token",
		isPending: model.isChangingBreakGlass,
		onConfirm: Message.ClickedConfirmBreakGlass(),
	})

export const deletePageDialog = (h: H, model: Model, page: V2StatusPage): Html =>
	confirmDialog(h, {
		slotId: "status-page-delete",
		model: model.deletePageDialog,
		toParentMessage: (message) => Message.GotDeletePageDialogMessage({ message }),
		title: `Delete ${page.name}?`,
		description: `${publicPath(page.slug)} goes offline and its components and incidents are deleted. This cannot be undone.`,
		confirmLabel: "Delete status page",
		isPending: model.isDeletingPage,
		onConfirm: Message.ClickedConfirmDeletePage(),
	})
