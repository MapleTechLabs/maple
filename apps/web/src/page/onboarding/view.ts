import { isClerkAuthEnabled } from "../../lib/services/common/auth-mode"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as OrgSwitcherView from "../../shell/clerk-org-switcher-view"
import { accountLayout } from "../../layout/account-layout"
import { currentRegion, MAPLE_REGION_LABELS, regionAppUrl } from "../../lib/region"
import { button, linkButton } from "../../ui/button"
import { authDescription, authLayout, authTitle } from "./auth-layout"
import type * as ClerkScreens from "./clerk-screens"
import { clerkCard } from "./clerk-card"
import * as ClerkSignInView from "./clerk-sign-in-view"
import * as AccountMenu from "./account-menu"
import { accessOf, customerOf, needsRegion } from "./plan-gate"
import * as SelectPlan from "./select-plan"
import type * as QuickStart from "./quick-start"
import { Message as QuickStartMessage } from "./quick-start"
import * as QuickStartTeamView from "./quick-start-team-view"
import * as PricingCardsView from "./pricing-cards-view"
import * as QuickStartView from "./quick-start-view"
import { bootSplash } from "../../layout/boot-splash"
import * as MenuView from "../../ui/menu-view"
import type * as CliLogin from "./cli-login"
import * as CliLoginView from "./cli-login-view"
import {
	type Message,
	type Model,
	type Screen,
	toClerkSignIn,
	toCliLogin,
	toMcpAuthorize,
	toQuickStart,
	toSelectPlan,
	toSwitcher,
	toUnsubscribe,
	toUserMenu,
} from "./index"
import type { Inputs } from "./inputs"
import type * as McpAuthorize from "./mcp-authorize"
import * as McpAuthorizeView from "./mcp-authorize-view"
import * as Unsubscribe from "./unsubscribe"
import { selfHostedWorkspace, workspaceCard } from "./workspace"

/** A screen's view inputs: the session, plus markup the container owns (the org switcher). */
type ScreenInputs = Inputs & Readonly<{ workspace: () => Html }>

const cliLoginView = Submodel.defineView<CliLogin.Model, CliLogin.Message, ScreenInputs>((model, inputs, h) =>
	CliLoginView.view(h, model, inputs.workspace()),
)

const mcpAuthorizeView = Submodel.defineView<McpAuthorize.Model, McpAuthorize.Message, ScreenInputs>(
	(model, inputs, h) => McpAuthorizeView.view(h, model, inputs.workspace()),
)

const unsubscribeView = Submodel.defineView<Unsubscribe.Model, Unsubscribe.Message>((model, h) =>
	Unsubscribe.view(h, model),
)

type SwitcherToView = OrgSwitcherView.ViewInputs["toView"]

/** `ClerkOrgSwitcherMenu` around the screen's own trigger. */
const switcher = (
	h: HtmlBuilder<Message>,
	model: Model,
	inputs: Inputs,
	align: "start" | "end",
	toView: SwitcherToView,
): Html =>
	h.submodel({
		slotId: "onboarding-org-switcher",
		model: model.switcher,
		view: OrgSwitcherView.view,
		viewInputs: { memberships: inputs.memberships, activeOrgId: inputs.maybeOrgId, align, toView },
		toParentMessage: toSwitcher,
	})

/** `ClerkWorkspaceChoice`: the active org's name and the "Switch" menu, aligned to the card's end. */
const clerkWorkspace = (h: HtmlBuilder<Message>, model: Model, inputs: Inputs): Html =>
	switcher(h, model, inputs, "end", ({ trigger, withTrigger }) =>
		workspaceCard(
			h,
			Option.match(inputs.maybeOrganization, {
				onNone: () => "Current workspace",
				onSome: (org) => org.name,
			}),
			withTrigger(button(h, { variant: "outline", size: "sm", attributes: trigger }, ["Switch"])),
		),
	)

/** `OnboardingOrgSwitcher` and `OnboardingUserMenu`: the header's account actions. */
const accountCluster = (h: HtmlBuilder<Message>, model: Model, inputs: Inputs, label: Html): Html => {
	const orgName = Option.match(inputs.maybeOrganization, {
		onNone: () => "Select organization",
		onSome: (org) => org.name,
	})
	// Nested so both menus' triggers and guards land as siblings in the one cluster `div`.
	const userMenu = (before: ReadonlyArray<Html>): Html =>
		h.submodel({
			slotId: "onboarding-user-menu",
			model: model.userMenu,
			view: MenuView.view,
			viewInputs: {
				entries: AccountMenu.userMenuEntries(h, inputs.maybeUser),
				className: isClerkAuthEnabled ? "min-w-56" : "min-w-44",
				side: "bottom",
				align: "end",
				sideOffset: 4,
				toView: ({ trigger, withTrigger }) =>
					QuickStartView.accountClusterOf(h, [
						label,
						...before,
						...withTrigger(
							button(
								h,
								{
									variant: "outline",
									size: "sm",
									className: "pl-1 pr-2",
									attributes: [h.AriaLabel("Account menu"), ...trigger],
								},
								AccountMenu.userTriggerChildren(h, inputs.maybeUser),
							),
						),
					]),
			},
			toParentMessage: toUserMenu,
		})
	if (!isClerkAuthEnabled) return userMenu([])
	return switcher(h, model, inputs, "end", ({ trigger, withTrigger }) =>
		userMenu(
			withTrigger(
				button(
					h,
					{ variant: "outline", size: "sm", className: "pl-1.5 text-xs", attributes: trigger },
					AccountMenu.orgTriggerChildren(h, orgName),
				),
			),
		),
	)
}

/** `QuickStartPage`: the splash until the progress and the plan are known, then the step. */
const quickStartView = Submodel.defineView<
	QuickStart.Model,
	QuickStart.Message,
	ScreenInputs & Readonly<{ accountCluster: (label: Html) => Html }>
>((model, inputs, h) =>
	model.state === null ||
	(!needsRegion(inputs.maybeOrganization) && accessOf(inputs.customer) === "loading")
		? bootSplash(h)
		: QuickStartView.view(h, model, {
				accountCluster: inputs.accountCluster,
				needsRegion: needsRegion(inputs.maybeOrganization),
				teamStep: () => QuickStartTeamView.teamStep(h, model.team),
				planStep: QuickStartTeamView.planStep(
					h,
					accessOf(inputs.customer) === "loading",
					h.submodel({
						slotId: "quick-start-pricing",
						model: model.pricing,
						view: PricingCardsView.view,
						toParentMessage: (message) => QuickStartMessage.GotPricingMessage({ message }),
					}),
				),
			}),
)

/** `SelectPlanPageInner`: the splash until the customer is known. */
const selectPlanView = Submodel.defineView<SelectPlan.Model, SelectPlan.Message, ScreenInputs>(
	(model, inputs, h) =>
		accessOf(inputs.customer) === "loading"
			? bootSplash(h)
			: SelectPlan.view(h, model, customerOf(inputs.customer)),
)

/** `OrgRequiredPageClerk`. */
const orgRequiredView = (h: HtmlBuilder<Message>, model: Model, inputs: Inputs): Html =>
	authLayout(h, "max-w-lg", [
		authTitle(h, ["Organization required"]),
		authDescription(h, ["Select or create an organization before entering the app."]),
		switcher(h, model, inputs, "start", ({ trigger, withTrigger }) =>
			h.div(
				[h.Class("mt-4")],
				withTrigger(
					button(h, { variant: "outline", attributes: trigger }, ["Select or create organization"]),
				),
			),
		),
	])

/** `WrongRegionScreen`: this region has nothing to show for an org another region serves. */
const wrongRegionView = (
	h: HtmlBuilder<Message>,
	model: Model,
	inputs: Inputs,
	screen: ClerkScreens.WrongRegion,
): Html => {
	const orgName = Option.match(inputs.maybeOrganization, {
		onNone: () => "This organization",
		onSome: (org) => org.name,
	})
	const target = MAPLE_REGION_LABELS[screen.region]
	const here = MAPLE_REGION_LABELS[currentRegion]
	const url = regionAppUrl(screen.region)
	return authLayout(h, "max-w-lg", [
		// One text node per part.
		authTitle(h, [orgName, " is in the ", target.short, " region"]),
		authDescription(h, [
			"Its data is stored in the ",
			target.name,
			". You are on the ",
			here.short,
			" dashboard, which keeps a separate set of organizations.",
		]),
		switcher(h, model, inputs, "start", ({ trigger, withTrigger }) =>
			h.div(
				[h.Class("mt-6 flex flex-wrap items-center gap-2")],
				[
					...(url === undefined
						? []
						: [linkButton(h, { href: `${url}${screen.href}` }, [`Open in ${target.short}`])]),
					...withTrigger(
						button(h, { variant: "outline", attributes: trigger }, ["Switch organization"]),
					),
				],
			),
		),
	])
}

const screenView = (h: HtmlBuilder<Message>, model: Model, inputs: Inputs): Html => {
	const screen: Screen = model.screen
	const slotId = `onboarding:${screen._tag}`
	const viewInputs: ScreenInputs = {
		...inputs,
		workspace: () =>
			isClerkAuthEnabled ? clerkWorkspace(h, model, inputs) : selfHostedWorkspace(h, inputs.maybeOrgId),
	}
	switch (screen._tag) {
		case "CliLogin":
			return h.submodel({
				slotId,
				model: screen,
				view: cliLoginView,
				viewInputs,
				toParentMessage: toCliLogin,
			})
		case "McpAuthorize":
			return h.submodel({
				slotId,
				model: screen,
				view: mcpAuthorizeView,
				viewInputs,
				toParentMessage: toMcpAuthorize,
			})
		case "Unsubscribe":
			return h.submodel({
				slotId,
				model: screen,
				view: unsubscribeView,
				toParentMessage: toUnsubscribe,
			})
		case "ClerkSignIn":
			return ClerkSignInView.view(h, screen, toClerkSignIn)
		case "SignUp":
			return accountLayout(h, [clerkCard(h, "SignUp", screen.target)])
		case "OrgRequired":
			return orgRequiredView(h, model, inputs)
		case "WrongRegion":
			return wrongRegionView(h, model, inputs, screen)
		case "SelectPlan":
			return h.submodel({
				slotId,
				model: screen,
				view: selectPlanView,
				viewInputs,
				toParentMessage: toSelectPlan,
			})
		case "QuickStart":
			return h.submodel({
				slotId,
				model: screen,
				view: quickStartView,
				viewInputs: {
					...viewInputs,
					accountCluster: (label) => accountCluster(h, model, inputs, label),
				},
				toParentMessage: toQuickStart,
			})
	}
}

export const view = Submodel.defineView<Model, Message, Inputs>((model, inputs, h) =>
	screenView(h, model, inputs),
)
