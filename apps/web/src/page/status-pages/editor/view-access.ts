import { cn } from "@maple/ui/lib/utils"
import type { StatusPageVisibility } from "@maple/domain"
import type { V2StatusPage } from "@maple/domain/http/v2"
import { Option, Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { choiceCard } from "@maple/views/ui/choice-card"
import { icon, type IconName } from "@maple/views/ui/icon"
import { vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { failureMessage } from "@maple/views/data/load-failure"
import { saveBar } from "../../kit/save-bar"
import { denialReason } from "../../kit/session-grants"
import { adminOnlyNote, settingsSection } from "../../kit/settings-section"
import { textField } from "../shared/fields"
import type { SettingsForm } from "../shared/form"
import { fragmentFrame, onYourPage } from "../shared/preview"
import { addressBlock } from "./view-address"
import { draftSnapshot } from "./view-canvas"
import { renderAccessPage } from "@maple/status-page"
import { Message } from "./message"
import { canChangeAccess, type Model } from "./model"
import {
	accessIssue,
	blockedReason,
	draftVisibility,
	isAccessDirty,
	passwordIssue,
	removesPassword,
} from "./update-access"

// Basic settings > Who can view: public, behind a password, or members only, and the password form visitors
// meet. A pick and a typed password wait for the save bar.

type H = HtmlBuilder<Message>

const VISIBILITIES: ReadonlyArray<{
	readonly value: StatusPageVisibility
	readonly title: string
	readonly icon: IconName
	readonly description: string
}> = [
	{
		value: "public",
		title: "Public",
		icon: "GlobeIcon",
		description: "Anyone with the address sees the page, its feeds and its badge.",
	},
	{
		value: "password",
		title: "Password-protected",
		icon: "KeyIcon",
		description:
			"Visitors enter the page password first. No feeds or subscribe options, and search engines leave it out.",
	},
	{
		value: "internal",
		title: "Internal",
		icon: "ShieldIcon",
		description:
			"Only members of this organization, signed in to Maple. Its address and custom domain answer not found.",
	},
]

const visibilityChoice = (h: H, model: Model, page: V2StatusPage, option: (typeof VISIBILITIES)[number]) => {
	const blocked = blockedReason(model, page, option.value)
	const isPicked = draftVisibility(model, page) === option.value
	return choiceCard(
		h,
		{
			type: "radio",
			name: "status-page-visibility",
			label: option.title,
			isChecked: isPicked,
			isDisabled: !canChangeAccess(model) || model.accessAction !== null || blocked !== null,
			onChange: Message.PickedVisibility({ visibility: option.value }),
			className: "flex-col gap-1 p-3",
		},
		[
			icon(h, option.icon, {
				size: 16,
				className: cn("mb-1", isPicked ? "text-primary" : "text-muted-foreground"),
			}),
			typography(h, { size: "sm", weight: "medium" }, [option.title]),
			typography(h, { size: "xs", tone: "muted", as: "p" }, [option.description]),
			...(blocked === null || !canChangeAccess(model)
				? []
				: [typography(h, { size: "xs", tone: "muted", as: "p" }, [blocked])]),
		],
	)
}

const passwordField = (h: H, model: Model, page: V2StatusPage): Html =>
	textField(h, {
		id: "status-page-password",
		label: "Password",
		type: "password",
		value: model.passwordDraft,
		placeholder: page.has_password ? "Leave empty to keep the current password" : undefined,
		error: model.passwordDraft === "" ? null : passwordIssue(model.passwordDraft),
		hint: "Visitors enter it once per browser, for 30 days. A new password signs everyone out.",
		isDisabled: model.accessAction !== null,
		onInput: (value) => Message.ChangedPassword({ value }),
	})

/** What Save changes, or why it cannot. */
export const accessSaveContext = (model: Model, page: V2StatusPage): string => {
	const issue = accessIssue(model, page)
	if (issue !== null) return issue
	const picked = Arr.findFirst(VISIBILITIES, (option) => option.value === model.visibilityDraft)
	return Arr.join(
		[
			...Option.match(picked, { onNone: () => [], onSome: (option) => [option.title] }),
			...(model.passwordDraft === "" ? [] : ["New password"]),
			...(removesPassword(model, page) ? ["removes the page password"] : []),
		],
		", ",
	)
}

export const accessSaveBar = (h: H, model: Model, page: V2StatusPage): ReadonlyArray<Html> =>
	saveBar(h, {
		isDirty: isAccessDirty(model),
		isPending: model.accessAction !== null,
		context: accessSaveContext(model, page),
		onDiscard: Message.ClickedDiscardAccess(),
		onSave: Message.ClickedSaveAccess(),
		isSaveDisabled: accessIssue(model, page) !== null || model.accessAction !== null,
	})

export const accessSection = (h: H, model: Model, page: V2StatusPage, form: SettingsForm): Html =>
	settingsSection(
		h,
		{
			id: "status-page-settings-access",
			framed: false,
			title: "Who can view",
			description: ["Public, behind a password, or only for members of this organization."],
		},
		[
			vstack(h, { gap: "4" }, [
				...(canChangeAccess(model) ? [] : [adminOnlyNote(h, [denialReason("status_pages:access")])]),
				h.div(
					[h.Class("grid gap-2 sm:grid-cols-3"), h.Role("radiogroup"), h.AriaLabel("Who can view")],
					Arr.map(VISIBILITIES, (option) => visibilityChoice(h, model, page, option)),
				),
				...(canChangeAccess(model) && draftVisibility(model, page) === "password"
					? [passwordField(h, model, page)]
					: []),
				addressBlock(h, model, page),
				...(model.accessFailure === null
					? []
					: [
							alert(h, { variant: "crit", size: "sm" }, [
								icon(h, "CircleXmarkIcon"),
								alertTitle(h, ["Couldn't change who can view the page"]),
								alertDescription(h, [failureMessage(model.accessFailure)]),
							]),
						]),
				...(draftVisibility(model, page) === "password"
					? [
							onYourPage(
								h,
								fragmentFrame(h, {
									title: "The password form visitors see first",
									document: renderAccessPage(
										draftSnapshot(model, page, form, "live"),
										undefined,
										{
											inDashboard: true,
										},
									),
									className: "h-96",
								}),
								"What visitors see",
							),
						]
					: []),
			]),
		],
	)
