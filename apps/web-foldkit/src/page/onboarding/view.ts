import { isClerkAuthEnabled } from "@maple/web/lib/services/common/auth-mode"
import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as OrgSwitcherView from "../../shell/clerk-org-switcher-view"
import { accountLayout } from "../../layout/account-layout"
import { button } from "../../ui/button"
import { authDescription, authLayout, authTitle } from "./auth-layout"
import { clerkCard } from "./clerk-card"
import * as ClerkSignInView from "./clerk-sign-in-view"
import type * as CliLogin from "./cli-login"
import * as CliLoginView from "./cli-login-view"
import { type Message, type Model, type Screen, toClerkSignIn, toCliLogin, toMcpAuthorize, toSwitcher, toUnsubscribe } from "./index"
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
			Option.match(inputs.maybeOrganization, { onNone: () => "Current workspace", onSome: (org) => org.name }),
			withTrigger(button(h, { variant: "outline", size: "sm", attributes: trigger }, ["Switch"])),
		),
	)

/** `OrgRequiredPageClerk`. */
const orgRequiredView = (h: HtmlBuilder<Message>, model: Model, inputs: Inputs): Html =>
	authLayout(h, "max-w-lg", [
		authTitle(h, ["Organization required"]),
		authDescription(h, ["Select or create an organization before entering the app."]),
		switcher(h, model, inputs, "start", ({ trigger, withTrigger }) =>
			h.div(
				[h.Class("mt-4")],
				withTrigger(button(h, { variant: "outline", attributes: trigger }, ["Select or create organization"])),
			),
		),
	])

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
			return h.submodel({ slotId, model: screen, view: cliLoginView, viewInputs, toParentMessage: toCliLogin })
		case "McpAuthorize":
			return h.submodel({ slotId, model: screen, view: mcpAuthorizeView, viewInputs, toParentMessage: toMcpAuthorize })
		case "Unsubscribe":
			return h.submodel({ slotId, model: screen, view: unsubscribeView, toParentMessage: toUnsubscribe })
		case "ClerkSignIn":
			return ClerkSignInView.view(h, screen, toClerkSignIn)
		case "SignUp":
			return accountLayout(h, [clerkCard(h, "SignUp", screen.target)])
		case "OrgRequired":
			return orgRequiredView(h, model, inputs)
	}
}

export const view = Submodel.defineView<Model, Message, Inputs>((model, inputs, h) => screenView(h, model, inputs))
