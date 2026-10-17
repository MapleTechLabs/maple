import { Effect, Option, Schema } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { accountLayout } from "../layout/account-layout"
import { Message } from "../message"

/** `<SignIn forceRedirectUrl>` from @clerk/clerk-react, mounted by clerk-js into this element. */
const MountClerkSignIn = Mount.define("MountClerkSignIn", {
	args: { maybeRedirectUrl: Schema.Option(Schema.String) },
	messages: [Message.CompletedMountClerkSignIn, Message.FailedMountClerkSignIn],
	execute: ({ element, maybeRedirectUrl }) =>
		Option.match(Option.fromNullishOr(window.Clerk), {
			onNone: () => Effect.succeed(Message.FailedMountClerkSignIn({ message: "Clerk is not loaded" })),
			onSome: (clerk) =>
				Effect.acquireRelease(
					Effect.sync(() => {
						if (element instanceof HTMLDivElement) {
							clerk.mountSignIn(element, {
								forceRedirectUrl: Option.getOrUndefined(maybeRedirectUrl),
							})
						}
					}),
					() =>
						Effect.sync(() => {
							if (element instanceof HTMLDivElement) {
								clerk.unmountSignIn(element)
							}
						}),
				).pipe(Effect.as(Message.CompletedMountClerkSignIn())),
		}),
})

/** The Clerk-mode `/sign-in`. The PR-preview access form is not ported yet. */
export const view = (h: HtmlBuilder<Message>, maybeRedirectUrl: Option.Option<string>): Html =>
	accountLayout(h, [h.div([h.OnMount(MountClerkSignIn({ maybeRedirectUrl }))])])
