import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { BreadcrumbEntry } from "../../../shell"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { navShell } from "../kit/nav-shell"
import { Message, type Model } from "./model"
import { accountNavSections, accountTabLabels } from "./nav"
import * as ProfileView from "./profile/view"
import { activeTabOf } from "./update"

type H = HtmlBuilder<Message>

export const breadcrumbs = (model: Model): ReadonlyArray<BreadcrumbEntry> => [
	{ label: "Account", href: "/account" },
	{ label: accountTabLabels[activeTabOf(model)] },
]

const tabContent = (h: H, model: Model, _inputs: PageViewInputs): ReadonlyArray<Html> => {
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
				{ filters: navShell(h, accountNavSections, activeTabOf(model), (tab) => Message.ClickedTab({ tab })) },
				tabContent(h, model, inputs),
			),
)
