import { isClerkAuthEnabled } from "@maple/web/lib/services/common/auth-mode"
import { Effect, Schema, Stream } from "effect"
import { Dom, Subscription } from "foldkit"
import { Message } from "./message"
import type { Model } from "./model"
import { SELF_HOSTED_AUTH_EVENT } from "./platform/auth-api"
import { rendersShell } from "./page/chrome"
import { clerkSnapshots } from "./platform/clerk"
import * as Shell from "./shell"

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
	/** `useIsMobile` for the shell: the sidebar turns into a sheet below `md`. */
	shellViewport: entry(
		{},
		{
			modelToDependencies: () => ({}),
			dependenciesToStream: () =>
				Stream.map(Shell.viewportChanges, (message) => Message.GotShellMessage({ message })),
		},
	),
	/** ⌘B / Ctrl+B toggles the sidebar while a shell page is open (`SidebarProvider`). */
	shellSidebarShortcut: entry(
		{ isShellOpen: Schema.Boolean },
		{
			modelToDependencies: (model) => ({
				isShellOpen: model.session._tag === "SignedIn" && rendersShell(model.route),
			}),
			dependenciesToStream: ({ isShellOpen }) =>
				Stream.when(
					Stream.map(Shell.sidebarShortcut, (message) => Message.GotShellMessage({ message })),
					Effect.sync(() => isShellOpen),
				),
		},
	),
	/** `useAppVersionChanged`: only for a build that knows its commit, until it is known stale. */
	shellVersionPoll: entry(
		{ isPolling: Schema.Boolean },
		{
			modelToDependencies: (model) => ({
				isPolling: Shell.BUILT_COMMIT.length > 0 && !model.shell.isAppOutdated && model.session._tag === "SignedIn",
			}),
			dependenciesToStream: ({ isPolling }) =>
				Stream.when(
					Stream.map(Shell.versionChecks, (message) => Message.GotShellMessage({ message })),
					Effect.sync(() => isPolling),
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
