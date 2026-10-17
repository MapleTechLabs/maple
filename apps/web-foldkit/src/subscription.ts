import { isClerkAuthEnabled } from "@maple/web/lib/services/common/auth-mode"
import { Effect, Schema, Stream } from "effect"
import { Dom, Subscription } from "foldkit"
import { Message } from "./message"
import type { Model } from "./model"
import { SELF_HOSTED_AUTH_EVENT } from "./platform/auth-api"
import { clerkSnapshots } from "./platform/clerk"

const selfHostedAuthTarget: Dom.TypedEventTarget<{ [SELF_HOSTED_AUTH_EVENT]: Event }> = window

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
	/** `subscribeSelfHostedAuthChanges`: a renewal elsewhere ended or replaced the session. */
	selfHostedSession: entry(
		{ isSelfHosted: Schema.Boolean },
		{
			modelToDependencies: () => ({ isSelfHosted: !isClerkAuthEnabled }),
			dependenciesToStream: ({ isSelfHosted }) =>
				Stream.when(
					Dom.streamFromEvent({
						target: selfHostedAuthTarget,
						type: SELF_HOSTED_AUTH_EVENT,
						mapEvent: () => Message.ChangedSelfHostedSession(),
					}),
					Effect.sync(() => isSelfHosted),
				),
		},
	),
	/** Clerk's listener (what `useAuth()` re-renders on), once clerk-js has loaded. */
	clerkSession: entry(
		{ isClerkLoaded: Schema.Boolean },
		{
			modelToDependencies: (model) => ({ isClerkLoaded: model.clerk._tag === "Loaded" }),
			dependenciesToStream: ({ isClerkLoaded }) =>
				Stream.when(
					Stream.map(clerkSnapshots, (snapshot) => Message.ChangedClerkSession({ snapshot })),
					Effect.sync(() => isClerkLoaded),
				),
		},
	),
}))
