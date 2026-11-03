import { clerkAuthCardAppearance } from "../../lib/clerk-appearance"
import { Effect, Schema } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Message } from "./index"

// clerk-react's `<SignIn>` / `<SignUp>`: a `data-clerk-component` node that clerk-js mounts its
// prebuilt card into (`mountSignIn` / `mountSignUp`), unmounted when the node goes. The task cards
// (`mountTaskResetPassword` / `mountTaskSetupMFA`) finish a pending session, then go to `redirectUrlComplete`.

export const ClerkComponent = Schema.Literals(["SignIn", "SignUp", "TaskResetPassword", "TaskSetupMFA"])
export type ClerkComponent = typeof ClerkComponent.Type

export const MountClerkCard = Mount.define("MountClerkCard", {
	args: { component: ClerkComponent, forceRedirectUrl: Schema.NullOr(Schema.String) },
	messages: [Message.CompletedMountClerkCard],
	execute: ({ element, component, forceRedirectUrl }) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const clerk = window.Clerk
				if (clerk === undefined || !(element instanceof HTMLDivElement)) return
				// `<SignIn appearance={clerkAuthCardAppearance}>`: the unboxed card AccountLayout expects.
				const appearance = clerkAuthCardAppearance
				const props = forceRedirectUrl === null ? { appearance } : { appearance, forceRedirectUrl }
				const taskProps = { appearance, redirectUrlComplete: forceRedirectUrl ?? "/" }
				if (component === "SignIn") clerk.mountSignIn(element, props)
				else if (component === "SignUp") clerk.mountSignUp(element, props)
				else if (component === "TaskResetPassword") clerk.mountTaskResetPassword(element, taskProps)
				else clerk.mountTaskSetupMFA(element, taskProps)
			}),
			() =>
				Effect.sync(() => {
					const clerk = window.Clerk
					if (clerk === undefined || !(element instanceof HTMLDivElement)) return
					if (component === "SignIn") clerk.unmountSignIn(element)
					else if (component === "SignUp") clerk.unmountSignUp(element)
					else if (component === "TaskResetPassword") clerk.unmountTaskResetPassword(element)
					else clerk.unmountTaskSetupMFA(element)
				}),
		).pipe(Effect.as(Message.CompletedMountClerkCard())),
})

export const clerkCard = (
	h: HtmlBuilder<Message>,
	component: ClerkComponent,
	forceRedirectUrl: string | null,
): Html =>
	h.div([
		h.DataAttribute("clerk-component", component),
		h.OnMount(MountClerkCard({ component, forceRedirectUrl })),
	])
