import { cn } from "@maple/ui/lib/utils"
import type { V2StatusPage } from "@maple/domain/http/v2"
import { Array as Arr, Option, String as Str } from "effect"
import { absurd } from "effect/Function"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { button } from "@maple/views/ui/button"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import { copyableField } from "@maple/views/ui/copyable-field"
import { errorState } from "@maple/views/ui/error-state"
import { icon, type IconName } from "@maple/views/ui/icon"
import { skeleton } from "@maple/views/ui/skeleton"
import { textLink } from "@maple/views/ui/text-link"
import { failureMessage } from "@maple/views/data/load-failure"
import { dangerRow, dangerZone } from "../../kit/danger-zone"
import { navShell } from "../../kit/nav-shell"
import { saveBar } from "../../kit/save-bar"
import { adminOnlyNote, settingsSection, settingsSections } from "../../kit/settings-section"
import { SLUG_TAKEN_MESSAGE } from "../shared/slug"
import {
	publicAddress,
	publicUrl,
	SETTINGS_SECTIONS,
	type SettingsSection,
	statusPageHref,
} from "../shared/commands"
import { selectField, textareaField, textField } from "../shared/fields"
import {
	hasAppearanceIssues,
	hasPageFieldIssues,
	hasSettingsIssues,
	type SettingsForm,
	settingsFormOf,
	settingsIssues,
} from "../shared/form"
import { accessSaveBar, accessSaveContext, accessSection } from "./view-access"
import { appearanceSection, brandingSection, linksSection } from "./view-appearance"
import { customDomainSection } from "./view-domain"
import { jsonTab } from "./view-json"
import { monitorsSaveBar, monitorsSection } from "./view-monitors"
import { settingsPagePreview } from "./view-canvas"
import { pageUrlOf } from "./update-domain"
import { PREVIEW_FIELD_TARGETS } from "./command"
import { Message } from "./message"
import { canBreakGlass, canManage, type Model } from "./model"
import { gatedControl } from "../../kit/session-grants"
import { accessIssue, isAccessDirty } from "./update-access"
import { isSettingsDirty, settingsOf } from "./update-settings"
import { PREVIEWED_SECTIONS } from "./update"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"

// The Settings tab: a menu of sections beside the open one. Basic settings and Appearance edit one
// form with one save bar; each setting shows how it reads on the page.

type H = HtmlBuilder<Message>

const SECTION_LABEL = {
	basic: "Basic settings",
	monitors: "Monitors",
	appearance: "Appearance",
	advanced: "Advanced",
} as const satisfies Record<SettingsSection, string>

const SECTION_ICON = {
	basic: "GearIcon",
	monitors: "PulseIcon",
	appearance: "Palette2Icon",
	advanced: "CodeIcon",
} as const satisfies Record<SettingsSection, IconName>

const AUTO_INCIDENT_ENTRIES = [
	{ value: "off", label: "Off" },
	{ value: "draft", label: "Open a draft for me to publish" },
	{ value: "publish", label: "Open and publish an incident" },
]

/** The name the public page shows: the typed one, or the saved one while the field is empty. */
const nameShown = (form: SettingsForm, page: V2StatusPage): string =>
	Str.trim(form.name) === "" ? page.name : Str.trim(form.name)

/** The address in the Address hint: a link once it serves the saved page, plain text otherwise. */
const addressText = (h: H, page: V2StatusPage, url: string, isSaved: boolean): Html | string =>
	isSaved && page.visibility !== "internal" && !page.draft && Str.startsWith("http")(url)
		? textLink(h, { href: url, attributes: [h.Target("_blank"), h.Rel("noopener")] }, [url])
		: url

/** The Address hint's first sentence: only a published public or password page is read there. */
const whereVisitorsRead = (
	h: H,
	page: V2StatusPage,
	url: string,
	isSaved: boolean,
): ReadonlyArray<Html | string> => {
	const address = addressText(h, page, url, isSaved)
	if (page.visibility === "internal")
		return ["Its address is ", address, ", but internal pages are not served there."]
	if (page.draft) return ["Visitors will read the page at ", address, " once it is published."]
	return ["Visitors read the page at ", address, "."]
}

const pageSection = (h: H, model: Model, page: V2StatusPage, form: SettingsForm): Html => {
	const issues = settingsIssues(form)
	const isReadOnly = !canManage(model)
	return settingsSection(
		h,
		{
			id: "status-page-settings-page",
			framed: false,
			title: "Page",
			// It opens Basic settings: the menu already names it, so the title is for screen readers alone.
			isLead: true,
		},
		[
			vstack(h, { gap: "4" }, [
				textField(h, {
					id: PREVIEW_FIELD_TARGETS.name.id,
					label: "Name",
					value: form.name,
					isDisabled: isReadOnly,
					error: issues.name,
					hint: `Visitors see it in the browser tab and link previews as "${nameShown(form, page)} status", and in the page header when there is no logo. It also names the page in Maple.`,
					onInput: (value) => Message.ChangedSetting({ field: "name", value }),
				}),
				textField(h, {
					id: "status-page-slug",
					label: "Address",
					value: form.slug,
					isMono: true,
					isDisabled: isReadOnly,
					error:
						model.takenSlug !== null && model.takenSlug === form.slug
							? SLUG_TAKEN_MESSAGE
							: issues.slug,
					hint: [
						...whereVisitorsRead(
							h,
							page,
							publicUrl(model.publicBaseUrl, form.slug) ?? `/s/${form.slug}`,
							form.slug === page.slug,
						),
						" Each address belongs to one page across Maple; changing it moves the page and the old address stops working. A custom domain, below, serves the page at your own address instead.",
					],
					onInput: (value) => Message.ChangedSetting({ field: "slug", value }),
				}),
				textareaField(h, {
					id: "status-page-description",
					label: "Description",
					value: form.description,
					placeholder: "Live status of Acme's API, dashboard and integrations.",
					isDisabled: isReadOnly,
					hint: "Not shown on the page. Search engines and link previews in Slack, X and the like show it under the name. Left empty, they show the current status instead.",
					onInput: (value) => Message.ChangedSetting({ field: "description", value }),
				}),
			]),
		],
	)
}

const behaviourSection = (h: H, model: Model, form: SettingsForm): Html =>
	settingsSection(h, { id: "status-page-settings-behaviour", title: "Behaviour", framed: false }, [
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
			framed: false,
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

const deleteSection = (h: H, model: Model): Html =>
	dangerZone(h, { id: "status-page-settings-danger" }, [
		dangerRow(h, {
			title: "Delete status page",
			description: [
				"Takes the page offline and deletes its components and incidents. This cannot be undone.",
			],
			action: gatedControl(h, model, "status_pages:edit", (isDisabled) =>
				button(
					h,
					{
						variant: "destructive",
						size: "sm",
						isDisabled,
						attributes: [h.OnClick(Message.ClickedDeletePage())],
					},
					["Delete status page"],
				),
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
				accessSection(h, model, page, form),
				behaviourSection(h, model, form),
			]
		case "monitors":
			return [monitorsSection(h, model)]
		case "appearance":
			return [
				brandingSection(h, model, form),
				appearanceSection(h, model, form),
				linksSection(h, model, form),
			]
		case "advanced":
			return [
				// Break-glass posts at the public address, which an internal page does not answer on.
				...(page.visibility === "internal" ? [] : [breakGlassSection(h, model, page)]),
				jsonSection(h, model),
				deleteSection(h, model),
			]
	}
}

/** The sections as the page's left rail, the same rail the app's Settings uses. */
const settingsNav = (h: H, page: V2StatusPage, section: SettingsSection): Html =>
	navShell(
		h,
		[
			{
				id: "settings",
				title: "Settings",
				items: Arr.map(SETTINGS_SECTIONS, (entry) => ({
					kind: "link" as const,
					id: entry,
					href: statusPageHref(page.id, "settings", entry),
					label: SECTION_LABEL[entry],
					icon: SECTION_ICON[entry],
				})),
			},
		],
		section,
		(tab: never) => absurd(tab),
		"Settings sections",
	)

/**
 * Settings below the page's header and tabs: the section menu, the section's form and, for the
 * sections that change how the page looks, the page itself, side by side, each scrolling on its
 * own so the menu and preview stay in place. The preview needs the room of `xl`; below `md` the
 * menu sits above the form and both scroll with the page.
 */
export const settingsLayout = (
	h: H,
	model: Model,
	page: V2StatusPage,
	section: SettingsSection,
	content: Html,
): Html => {
	const hasPreview = PREVIEWED_SECTIONS.includes(section)
	return h.div(
		[
			h.Class(
				cn(
					"grid min-h-0 flex-1 md:grid-cols-[13rem_minmax(0,1fr)] md:grid-rows-1",
					hasPreview && "xl:grid-cols-[13rem_minmax(0,1fr)_minmax(20rem,0.8fr)]",
				),
			),
		],
		[
			h.div(
				[h.Class("min-h-0 border-b px-3 pb-4 md:overflow-y-auto md:border-r md:border-b-0")],
				[settingsNav(h, page, section)],
			),
			h.div([h.Class("min-h-0 px-(--page-gutter) pb-6 md:overflow-y-auto")], [content]),
			...(hasPreview
				? [
						h.aside(
							[h.Class("hidden min-h-0 border-l xl:flex xl:flex-col")],
							[
								settingsPagePreview(
									h,
									model,
									page,
									Option.getOrElse(settingsOf(model), () => settingsFormOf(page)),
								),
							],
						),
					]
				: []),
		],
	)
}

/**
 * Basic settings' fields and Who can view as one bar: Save and Discard act on both, so neither's
 * edits are left without a way to save them.
 */
const basicSaveBar = (h: H, model: Model, page: V2StatusPage, form: SettingsForm): ReadonlyArray<Html> =>
	saveBar(h, {
		isDirty: true,
		isPending: model.isSavingSettings || model.accessAction !== null,
		context: saveContext(model, form, "basic") ?? accessSaveContext(model, page),
		onDiscard: Message.ClickedDiscardBasic(),
		onSave: Message.ClickedSaveBasic(),
		isSaveDisabled: hasSettingsIssues(form) || model.isApplyingJson || accessIssue(model, page) !== null,
	})

/**
 * One bar at a time: under Monitors a moved order or an open component's edits, and under Basic
 * settings a changed Who can view, take it over the page's settings; Basic settings with both
 * edited saves both.
 */
const saveBars = (
	h: H,
	model: Model,
	page: V2StatusPage,
	form: SettingsForm,
	section: SettingsSection,
): ReadonlyArray<Html> => {
	if (section === "basic" && isAccessDirty(model) && isSettingsDirty(model))
		return basicSaveBar(h, model, page, form)
	const sectionBar =
		section === "monitors"
			? monitorsSaveBar(h, model)
			: section === "basic"
				? accessSaveBar(h, model, page)
				: []
	return sectionBar.length > 0
		? sectionBar
		: saveBar(h, {
				isDirty: isSettingsDirty(model),
				isPending: model.isSavingSettings,
				context: saveContext(model, form, section),
				onDiscard: Message.ClickedDiscardSettings(),
				onSave: Message.ClickedSaveSettings(),
				isSaveDisabled: hasSettingsIssues(form) || model.isApplyingJson,
			})
}

export const settingsView = (h: H, model: Model, page: V2StatusPage, section: SettingsSection): Html => {
	const form = Option.getOrElse(settingsOf(model), () => settingsFormOf(page))
	return vstack(h, { className: "min-w-0 max-w-3xl" }, [
		settingsSections(h, [
			...(canManage(model)
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
		...saveBars(h, model, page, form, section),
	])
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
