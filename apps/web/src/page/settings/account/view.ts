import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { BreadcrumbEntry } from "../../../shell"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { navShell } from "../kit/nav-shell"
import { Message, type Model } from "./model"
import { accountNavSections, accountTabLabels } from "./nav"
import * as ProfileView from "./profile/view"
import * as EmailPreferencesView from "./email-preferences/view"
import * as TwoFactorView from "./two-factor/view"
import * as SessionsView from "./sessions/view"
import * as ConnectionsView from "./connections/view"
import * as PasskeysView from "./passkeys/view"
import * as EmailsView from "./emails/view"
import * as PasswordView from "./password/view"
import { activeTabOf } from "./update"

type H = HtmlBuilder<Message>

export const breadcrumbs = (model: Model): ReadonlyArray<BreadcrumbEntry> => [
	{ label: "Account", href: "/account" },
	{ label: accountTabLabels[activeTabOf(model)] },
]

const tabContent = (h: H, model: Model, inputs: PageViewInputs): ReadonlyArray<Html> => {
	const tab = model.tab
	if (tab === null) return []
	switch (tab._tag) {
		case "Profile":
			return [
				h.submodel({
					slotId: "account-profile",
					model: tab.model,
					view: ProfileView.view,
					toParentMessage: (message) => Message.GotProfileMessage({ message }),
					viewInputs: {},
				}),
			]
		case "Password":
			return [
				h.submodel({
					slotId: "account-password",
					model: tab.model,
					view: PasswordView.view,
					toParentMessage: (message) => Message.GotPasswordMessage({ message }),
					viewInputs: {},
				}),
			]
		case "Emails":
			return [
				h.submodel({
					slotId: "account-emails",
					model: tab.model,
					view: EmailsView.view,
					toParentMessage: (message) => Message.GotEmailsMessage({ message }),
					viewInputs: {},
				}),
			]
		case "Passkeys":
			return [
				h.submodel({
					slotId: "account-passkeys",
					model: tab.model,
					view: PasskeysView.view,
					toParentMessage: (message) => Message.GotPasskeysMessage({ message }),
					viewInputs: { timeZone: inputs.context.timeZone },
				}),
			]
		case "Connections":
			return [
				h.submodel({
					slotId: "account-connections",
					model: tab.model,
					view: ConnectionsView.view,
					toParentMessage: (message) => Message.GotConnectionsMessage({ message }),
					viewInputs: {},
				}),
			]
		case "Sessions":
			return [
				h.submodel({
					slotId: "account-sessions",
					model: tab.model,
					view: SessionsView.view,
					toParentMessage: (message) => Message.GotSessionsMessage({ message }),
					viewInputs: { nowMs: model.nowMs, timeZone: inputs.context.timeZone },
				}),
			]
		case "TwoFactor":
			return [
				h.submodel({
					slotId: "account-two-factor",
					model: tab.model,
					view: TwoFactorView.view,
					toParentMessage: (message) => Message.GotTwoFactorMessage({ message }),
					viewInputs: {},
				}),
			]
		case "EmailPreferences":
			return [
				h.submodel({
					slotId: "account-email-preferences",
					model: tab.model,
					view: EmailPreferencesView.view,
					toParentMessage: (message) => Message.GotEmailPreferencesMessage({ message }),
					viewInputs: {},
				}),
			]
		case "Unported":
			// TODO(account): the remaining tabs are ported one by one; until then they render empty.
			return []
	}
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	model.tab === null
		? dashboardPage(h, {}, [])
		: dashboardPage(
				h,
				{
					filters: navShell(h, accountNavSections, activeTabOf(model), (tab) =>
						Message.ClickedTab({ tab }),
					),
					width: "settings",
				},
				tabContent(h, model, inputs),
			),
)
