import type { StatusPageVisibility } from "@maple/domain"
import type { V2StatusPage } from "@maple/domain/http/v2"
import { Option, Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { button, linkButton } from "@maple/views/ui/button"
import { choiceCard } from "@maple/views/ui/choice-card"
import { icon } from "@maple/views/ui/icon"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { failureMessage } from "@maple/views/data/load-failure"
import { adminOnlyNote, settingsSection } from "../../kit/settings-section"
import { statusPageViewHref } from "../shared/commands"
import { textField } from "../shared/fields"
import { Message } from "./message"
import { canChangeAccess, type Model } from "./model"
import { passwordIssue } from "./update-access"
import { customDomainOf } from "./update-domain"

// The Settings tab's Access section: public, behind a password, or members only.

type H = HtmlBuilder<Message>

const VISIBILITIES: ReadonlyArray<{
	readonly value: StatusPageVisibility
	readonly title: string
	readonly description: string
}> = [
	{
		value: "public",
		title: "Public",
		description: "Anyone with the address sees the page, its feeds and its badge.",
	},
	{
		value: "password",
		title: "Password-protected",
		description:
			"Visitors enter the page password first. No feeds or subscribe options, and search engines leave it out.",
	},
	{
		value: "internal",
		title: "Internal",
		description:
			"Only members of this organization, signed in to Maple. Its address and custom domain answer not found.",
	},
]

/** Why an option cannot be picked now, or null when it can. */
const blockedReason = (model: Model, page: V2StatusPage, value: StatusPageVisibility): string | null => {
	if (value === page.visibility) return null
	if (value === "password" && !page.has_password) return "Set a password below first."
	const hasDomain = Option.match(customDomainOf(model), {
		onNone: () => false,
		onSome: (domain) => domain.hostname !== null,
	})
	if (value === "internal" && hasDomain) return "Remove the custom domain first."
	return null
}

const visibilityChoice = (h: H, model: Model, page: V2StatusPage, option: (typeof VISIBILITIES)[number]) => {
	const blocked = blockedReason(model, page, option.value)
	return choiceCard(
		h,
		{
			type: "radio",
			name: "status-page-visibility",
			label: option.title,
			isChecked: page.visibility === option.value,
			isDisabled: !canChangeAccess(model) || model.accessAction !== null || blocked !== null,
			onChange: Message.PickedVisibility({ visibility: option.value }),
			className: "flex-col gap-1 p-3",
		},
		[
			typography(h, { size: "sm", weight: "medium" }, [option.title]),
			typography(h, { size: "xs", tone: "muted", as: "p" }, [option.description]),
			...(blocked === null || !canChangeAccess(model)
				? []
				: [typography(h, { size: "xs", tone: "muted", as: "p" }, [blocked])]),
		],
	)
}

const passwordForm = (h: H, model: Model, draft: string): Html => {
	const issue = draft === "" ? null : passwordIssue(draft)
	return h.form(
		[h.AriaLabel("Page password"), h.OnSubmit(Message.SubmittedPassword())],
		[
			textField(h, {
				id: "status-page-password",
				label: "New password",
				type: "password",
				value: draft,
				error: issue,
				hint: "Visitors enter it once per browser, for 30 days. A new password signs everyone out.",
				onInput: (value) => Message.ChangedPassword({ value }),
				trailing: hstack(h, { gap: "2" }, [
					button(
						h,
						{
							type: "submit",
							isLoading: model.accessAction === "password",
							isDisabled: passwordIssue(draft) !== null || model.accessAction !== null,
						},
						["Save password"],
					),
					button(
						h,
						{ variant: "ghost", attributes: [h.OnClick(Message.ClickedCancelPassword())] },
						["Cancel"],
					),
				]),
			}),
		],
	)
}

const passwordRow = (h: H, model: Model, page: V2StatusPage): Html => {
	if (model.passwordDraft !== null && canChangeAccess(model)) return passwordForm(h, model, model.passwordDraft)
	return hstack(h, { gap: "3", justify: "between", wrap: true }, [
		typography(h, { size: "sm", as: "p" }, [page.has_password ? "A page password is set" : "No page password"]),
		...(canChangeAccess(model)
			? [
					hstack(h, { gap: "2" }, [
						// A password page needs its password: it is removed after the page is opened up.
						...(page.has_password && page.visibility !== "password"
							? [
									button(
										h,
										{
											size: "sm",
											variant: "destructive-outline",
											isLoading: model.accessAction === "removePassword",
											isDisabled: model.accessAction !== null,
											attributes: [h.OnClick(Message.ClickedRemovePassword())],
										},
										["Remove password"],
									),
								]
							: []),
						button(
							h,
							{
								size: "sm",
								variant: "outline",
								isDisabled: model.accessAction !== null,
								attributes: [h.OnClick(Message.ClickedChangePassword())],
							},
							[icon(h, "KeyIcon"), page.has_password ? "Change password" : "Set password"],
						),
					]),
				]
			: []),
	])
}

export const accessSection = (h: H, model: Model, page: V2StatusPage): Html =>
	settingsSection(
		h,
		{
			id: "status-page-settings-access",
			title: "Who can view",
			description: ["Public, behind a password, or only for members of this organization."],
		},
		[
			vstack(h, { gap: "4" }, [
				...(canChangeAccess(model)
					? []
					: [adminOnlyNote(h, ["Only org admins can change who can view a status page."])]),
				h.div(
					[h.Class("grid gap-2 sm:grid-cols-3"), h.Role("radiogroup"), h.AriaLabel("Who can view")],
					Arr.map(VISIBILITIES, (option) => visibilityChoice(h, model, page, option)),
				),
				passwordRow(h, model, page),
				...(page.visibility === "internal"
					? [
							hstack(h, { gap: "3", justify: "between", wrap: true }, [
								typography(h, { size: "xs", tone: "muted", as: "p" }, [
									"Members read the page inside Maple.",
								]),
								linkButton(h, { size: "sm", variant: "outline", href: statusPageViewHref(page.id) }, [
									icon(h, "EyeIcon"),
									"Open page",
								]),
							]),
						]
					: []),
				...(model.accessFailure === null
					? []
					: [
							alert(h, { variant: "crit", size: "sm" }, [
								icon(h, "CircleXmarkIcon"),
								alertTitle(h, ["Couldn't change who can view the page"]),
								alertDescription(h, [failureMessage(model.accessFailure)]),
							]),
						]),
			]),
		],
	)
