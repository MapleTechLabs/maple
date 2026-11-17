import type { V2StatusPage } from "@maple/domain/http/v2"
import { Array as Arr, Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { button } from "@maple/views/ui/button"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import { copyableField } from "@maple/views/ui/copyable-field"
import { errorState } from "@maple/views/ui/error-state"
import { icon, type IconName } from "@maple/views/ui/icon"
import { navRailRow } from "@maple/views/ui/nav-rail-row"
import { searchResultMockup } from "@maple/views/ui/page-mockup"
import { pageTitle } from "@maple/status-page"
import { skeleton } from "@maple/views/ui/skeleton"
import { failureMessage } from "@maple/views/data/load-failure"
import { dangerRow, dangerZone } from "../../kit/danger-zone"
import { saveBar } from "../../kit/save-bar"
import { adminOnlyNote, settingsSection, settingsSections } from "../../kit/settings-section"
import { switchRow } from "../../kit/switch-row"
import {
	canonicalUrl,
	publicAddress,
	SETTINGS_SECTIONS,
	type SettingsSection,
	statusPageHref,
} from "../shared/commands"
import { selectField, textareaField, textField } from "../shared/fields"
import {
	hasAppearanceIssues,
	hasPageFieldIssues,
	hasSettingsIssues,
	orNull,
	type SettingsForm,
	settingsFormOf,
	settingsIssues,
} from "../shared/form"
import { onYourPage } from "../shared/preview"
import { accessSection } from "./view-access"
import { appearanceSection, brandingSection } from "./view-appearance"
import { customDomainSection } from "./view-domain"
import { jsonTab } from "./view-json"
import { monitorsSection } from "./view-monitors"
import { draftName, settingsPagePreview, tabPreview } from "./view-canvas"
import { activeCustomDomain, pageUrlOf } from "./update-domain"
import { Message } from "./message"
import { canBreakGlass, canManage, type Model } from "./model"
import { isSettingsDirty, settingsOf } from "./update-settings"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { grid } from "@maple/views/ui/grid"
import { hstack, vstack } from "@maple/views/ui/stack"

// The Settings tab: a menu of sections beside the open one. Basic settings and Appearance edit one
// form with one save bar; each setting shows how it reads on the page.

type H = HtmlBuilder<Message>

const SECTION_LABEL = {
	basic: "Basic settings",
	monitors: "Monitors",
	appearance: "Appearance",
	access: "Access",
	advanced: "Advanced",
} as const satisfies Record<SettingsSection, string>

const SECTION_ICON = {
	basic: "GearIcon",
	monitors: "PulseIcon",
	appearance: "PaletteIcon",
	access: "LockIcon",
	advanced: "CodeIcon",
} as const satisfies Record<SettingsSection, IconName>

const AUTO_INCIDENT_ENTRIES = [
	{ value: "off", label: "Off" },
	{ value: "draft", label: "Open a draft for me to publish" },
	{ value: "publish", label: "Open and publish an incident" },
]

/** The address the form's slug gives the page, for the previews; the custom domain wins once active. */
const draftAddress = (model: Model, form: SettingsForm): string =>
	canonicalUrl(model.publicBaseUrl, form.slug, activeCustomDomain(model)) ?? publicAddress(form.slug)

const pageSection = (h: H, model: Model, page: V2StatusPage, form: SettingsForm): Html => {
	const issues = settingsIssues(form)
	const isReadOnly = !canManage(model)
	const address = draftAddress(model, form)
	return settingsSection(
		h,
		{
			id: "status-page-settings-page",
			title: "Page",
			description: ["How the page introduces itself to visitors."],
		},
		[
			vstack(h, { gap: "4" }, [
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
					hint: `${publicAddress(form.slug)}. Changing it moves the page; the old address stops working.`,
					onInput: (value) => Message.ChangedSetting({ field: "slug", value }),
				}),
				onYourPage(h, tabPreview(h, page, form, address)),
				textareaField(h, {
					id: "status-page-description",
					label: "Description",
					value: form.description,
					isDisabled: isReadOnly,
					onInput: (value) => Message.ChangedSetting({ field: "description", value }),
				}),
				onYourPage(
					h,
					searchResultMockup(h, {
						address,
						title: pageTitle(draftName(page, form)),
						description: orNull(form.description),
					}),
					"In search results and link previews",
				),
				grid(h, { sm: 2, gap: "4" }, [
					textField(h, {
						id: "status-page-website",
						label: "Website URL",
						value: form.websiteUrl,
						placeholder: "https://acme.example",
						isDisabled: isReadOnly,
						error: issues.websiteUrl,
						hint: "Linked in the page header as Visit website.",
						onInput: (value) => Message.ChangedSetting({ field: "websiteUrl", value }),
					}),
					textField(h, {
						id: "status-page-support",
						label: "Support URL",
						value: form.supportUrl,
						placeholder: "https://acme.example/support",
						isDisabled: isReadOnly,
						error: issues.supportUrl,
						hint: "Linked in the page header as Contact support.",
						onInput: (value) => Message.ChangedSetting({ field: "supportUrl", value }),
					}),
					textField(h, {
						id: "status-page-privacy",
						label: "Privacy policy URL",
						value: form.privacyUrl,
						placeholder: "https://acme.example/privacy",
						isDisabled: isReadOnly,
						error: issues.privacyUrl,
						hint: "Linked in the page footer.",
						onInput: (value) => Message.ChangedSetting({ field: "privacyUrl", value }),
					}),
					textField(h, {
						id: "status-page-terms",
						label: "Terms of service URL",
						value: form.termsUrl,
						placeholder: "https://acme.example/terms",
						isDisabled: isReadOnly,
						error: issues.termsUrl,
						hint: "Linked in the page footer.",
						onInput: (value) => Message.ChangedSetting({ field: "termsUrl", value }),
					}),
				]),
			]),
		],
	)
}

const behaviourSection = (h: H, model: Model, form: SettingsForm): Html =>
	settingsSection(h, { id: "status-page-settings-behaviour", title: "Behaviour" }, [
		vstack(h, { gap: "4" }, [
			selectField(h, {
				id: "status-page-auto-incidents",
				label: "When a linked monitor goes down",
				value: form.autoIncidents,
				entries: AUTO_INCIDENT_ENTRIES,
				isDisabled: !canManage(model),
				hint: "A draft waits for you under Incidents; a published one shows on the page at once.",
				onInput: (value) => Message.ChangedSetting({ field: "autoIncidents", value }),
			}),
			switchRow(h, {
				id: "status-page-powered-by",
				label: "Show powered by Maple",
				description: "A small credit in the page footer.",
				isChecked: form.showPoweredBy,
				isDisabled: !canManage(model),
				onToggle: Message.ToggledPoweredBy(),
			}),
		]),
	])

export const revealedToken = (h: H, model: Model): ReadonlyArray<Html> =>
	model.revealedToken === null
		? []
		: [
				vstack(h, { gap: "2", className: "rounded-md border bg-surface-faint p-3" }, [
					copyableField(h, {
						id: "status-page-break-glass-token",
						value: model.revealedToken.token,
						copyLabel: "break-glass token",
						copy: model.tokenCopy,
						toCopyMessage: (message) => Message.GotTokenCopyMessage({ message }),
					}),
					hstack(h, { gap: "3", justify: "between" }, [
						typography(h, { size: "xs", tone: "muted", as: "p" }, [
							"Store it outside Maple, in your password manager. It is not shown again.",
						]),
						button(
							h,
							{
								size: "sm",
								variant: "ghost",
								attributes: [h.OnClick(Message.ClickedDismissToken())],
							},
							["Done"],
						),
					]),
				]),
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
				h.code(
					[h.Class(typographyClass({ size: "xs", mono: true }))],
					[`${pageUrlOf(model, page) ?? publicAddress(page.slug)}/_manage`],
				),
				". The page keeps serving from edge storage either way.",
			],
		},
		[
			vstack(h, { gap: "3" }, [
				hstack(h, { gap: "3", justify: "between", wrap: true }, [
					typography(
						h,
						{ size: "sm", as: "p" },
						suffix === null
							? [typography(h, { tone: "muted" }, ["No token issued"])]
							: [
									"Active token ending in ",
									h.code([h.Class(typographyClass({ size: "xs", mono: true }))], [suffix]),
								],
					),
					...(canBreakGlass(model)
						? [
								hstack(h, { gap: "2" }, [
									...(suffix === null
										? []
										: [
												button(
													h,
													{
														size: "sm",
														variant: "destructive-outline",
														attributes: [h.OnClick(Message.ClickedRevokeToken())],
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
								]),
							]
						: []),
				]),
				...revealedToken(h, model),
			]),
		],
	)
}

/** The page as one JSON document, with its read's loading and failure states. */
const jsonSection = (h: H, model: Model): Html => {
	const failure = AsyncData.getError(model.config.data)
	return settingsSection(h, { id: "status-page-settings-json", title: "Page JSON", framed: false }, [
		Option.isSome(failure)
			? errorState(h, {
					failure: failure.value,
					title: "Couldn't load the config",
					onRetry: Message.ClickedRetry(),
					className: "py-12",
				})
			: AsyncData.hasData(model.config.data)
				? jsonTab(h, model)
				: skeleton(h, "h-48 w-full"),
	])
}

const deleteSection = (h: H): Html =>
	dangerZone(h, { id: "status-page-settings-danger" }, [
		dangerRow(h, {
			title: "Delete status page",
			description: [
				"Takes the page offline and deletes its components and incidents. This cannot be undone.",
			],
			action: button(
				h,
				{ variant: "destructive", size: "sm", attributes: [h.OnClick(Message.ClickedDeletePage())] },
				["Delete status page"],
			),
		}),
	])

/** Basic settings and Appearance share one form: a problem in the other still blocks the save. */
const saveContext = (model: Model, form: SettingsForm, section: SettingsSection): string | undefined => {
	if (hasSettingsIssues(form)) {
		const isHere =
			section === "appearance"
				? hasAppearanceIssues(form)
				: section === "basic" && hasPageFieldIssues(form)
		return isHere
			? "Fix the fields marked above."
			: `Fix the fields marked in ${hasPageFieldIssues(form) ? "Basic settings" : "Appearance"}.`
	}
	return model.isApplyingJson ? "Saving waits for the JSON apply to finish." : undefined
}

const sectionBody = (
	h: H,
	model: Model,
	page: V2StatusPage,
	form: SettingsForm,
	section: SettingsSection,
): ReadonlyArray<Html> => {
	switch (section) {
		case "basic":
			return [
				pageSection(h, model, page, form),
				customDomainSection(h, model, page),
				behaviourSection(h, model, form),
			]
		case "monitors":
			return [monitorsSection(h, model)]
		case "appearance":
			return [brandingSection(h, model, page, form), appearanceSection(h, model, form)]
		case "access":
			return [accessSection(h, model, page, form)]
		case "advanced":
			return [
				// Break-glass posts at the public address, which an internal page does not answer on.
				...(page.visibility === "internal" ? [] : [breakGlassSection(h, model, page)]),
				jsonSection(h, model),
				...(canManage(model) ? [deleteSection(h)] : []),
			]
	}
}

const sectionMenu = (h: H, page: V2StatusPage, section: SettingsSection): Html =>
	h.nav(
		[h.AriaLabel("Settings sections"), h.Class("md:sticky md:top-6")],
		[
			vstack(
				h,
				{ gap: "0.5" },
				Arr.map(SETTINGS_SECTIONS, (entry) =>
					navRailRow(
						h,
						{
							isActive: entry === section,
							href: statusPageHref(page.id, "settings", entry),
							attributes: [h.Key(entry)],
						},
						[icon(h, SECTION_ICON[entry], { size: 16 }), SECTION_LABEL[entry]],
					),
				),
			),
		],
	)

export const settingsView = (h: H, model: Model, page: V2StatusPage, section: SettingsSection): Html => {
	const form = Option.getOrElse(settingsOf(model), () => settingsFormOf(page))
	return h.div(
		[
			// The wide breakpoint is in rem like `md`: Tailwind orders a px `min-[…]` before the rem
			// breakpoints, so `md`'s two columns would win and the preview would wrap under the menu.
			h.Class(
				"grid items-start gap-6 md:grid-cols-[12rem_minmax(0,1fr)] lg:gap-10 min-[85rem]:grid-cols-[11rem_minmax(26rem,1fr)_minmax(20rem,1fr)]",
			),
		],
		[
			sectionMenu(h, page, section),
			vstack(h, { className: "min-w-0 max-w-3xl" }, [
				settingsSections(h, [
					...(canManage(model) || section === "access"
						? []
						: [
								adminOnlyNote(h, [
									"Only org admins and engineers can change a status page. You can still post incident updates.",
								]),
							]),
					...sectionBody(h, model, page, form, section),
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
					context: saveContext(model, form, section),
					onDiscard: Message.ClickedDiscardSettings(),
					onSave: Message.ClickedSaveSettings(),
					isSaveDisabled: hasSettingsIssues(form) || model.isApplyingJson,
				}),
			]),
			h.aside(
				[
					h.Class(
						"min-w-0 md:col-start-2 min-[85rem]:sticky min-[85rem]:top-6 min-[85rem]:col-start-auto",
					),
				],
				[settingsPagePreview(h, model, page, form)],
			),
		],
	)
}

/** The section's name, for the breadcrumb. */
export const sectionLabel = (section: SettingsSection): string => SECTION_LABEL[section]

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
		description: `${publicAddress(page.slug)} goes offline and its components and incidents are deleted. This cannot be undone.`,
		confirmLabel: "Delete status page",
		isPending: model.isDeletingPage,
		onConfirm: Message.ClickedConfirmDeletePage(),
	})
