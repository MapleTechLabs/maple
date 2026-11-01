import { OrgId } from "@maple/domain"
import {
	GithubIntegrationStatus,
	GithubInstallationSelection,
	IntegrationsValidationError,
} from "@maple/domain/http"
import { Result, Schema } from "effect"
import {
	type AnyCommand,
	type SceneSimulation,
	click,
	Command,
	expect as expectView,
	given,
	role,
	scene,
	Subscription,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../data/load-failure"
import type { PageContext, PageOutMessage } from "../contract"
import { FetchSourcesList, ScrollToTop } from "../sources/new/command"
import { Message } from "../sources/new/message"
import type { Model } from "../sources/new/model"
import { init, update } from "../sources/new/update"
import { view as pageView } from "../sources/new/view"
import { Message as IntegrationMessage } from "./message"
import { subscriptions } from "./subscription"
import { SelectGithubInstallation } from "./github"
import { LoadGithub, TrackConnected } from "./command"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_acme"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const inner = (model: Model, message: IntegrationMessage) =>
	pageUpdate(model, Message.GotIntegrationsMessage({ message })).model

const requestKeyOf = (commands: ReadonlyArray<AnyCommand>, name: string) =>
	Schema.decodeUnknownSync(Schema.Struct({ key: Schema.String }))(
		commands.find((command) => command.name === name)?.args,
	).key

const repo = (id: string, name: string, syncStatus: string, lastSyncError: string | null = null) => ({
	id: `0199a005-0000-7000-8000-00000000000${id}`,
	fullName: `acme/${name}`,
	htmlUrl: `https://github.com/acme/${name}`,
	isPrivate: false,
	status: "active",
	syncStatus,
	lastSyncedAt: null,
	lastSyncError,
	trackedBranch: "main",
	branches: [{ name: "main", isDefault: true }],
	prReviewEnabled: false,
})

const status = (overrides: Record<string, unknown> = {}) =>
	Schema.decodeUnknownSync(GithubIntegrationStatus)({
		connected: true,
		state: "connected",
		accountLogin: "acme",
		accountType: "organization",
		repositorySelection: "selected",
		ciTracesEnabled: true,
		repositoryDiscovery: null,
		repositories: [repo("1", "web", "ready"), repo("2", "api", "backfilling")],
		...overrides,
	})

const withStatus = (value: GithubIntegrationStatus): Model => {
	const entered = init({ _tag: "SourcesNew", search: { integration: "github" } }, context).model
	return inner(
		entered,
		IntegrationMessage.CompletedLoadGithub({
			key: entered.integrations.statuses.github.key ?? "",
			result: Result.succeed(value),
		}),
	)
}

const disconnected = () =>
	withStatus(
		status({
			connected: false,
			state: "not_connected",
			accountLogin: null,
			accountType: null,
			repositorySelection: null,
			repositories: [],
		}),
	)

const selection = Schema.decodeUnknownSync(GithubInstallationSelection)({
	state: "selection-1",
	needsApproval: [],
	installUrl: "https://github.test/apps/maple/installations/new?state=install-1",
	installations: [
		{ id: "101", accountLogin: "personal", accountType: "user", repositorySelection: "all" },
		{ id: "202", accountLogin: "acme", accountType: "organization", repositorySelection: "selected" },
	],
})

const discovered = (hasOpener = true) =>
	pageUpdate(
		disconnected(),
		Message.GotIntegrationsMessage({
			message: hasOpener
				? IntegrationMessage.ReceivedConnectMessage({
						provider: "github",
						status: "success",
						message: "Choose an account",
						github: selection,
					})
				: IntegrationMessage.CompletedOAuthReturn({
						outcome: {
							provider: "github",
							connector: null,
							status: "success",
							message: "Choose an account",
							chat: null,
							github: selection,
							isHandedOff: false,
						},
					}),
		}),
	)

describe("github connect flow", () => {
	test("before install, Connect offers the install and Continue stays locked", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				withStatus(
					status({
						connected: false,
						state: "not_connected",
						accountLogin: null,
						accountType: null,
						repositorySelection: null,
						repositories: [],
					}),
				),
			),
			expectView(role("listitem", { current: "step", name: "Connect" })).toExist(),
			expectView(role("button", { name: "Connect GitHub" })).toExist(),
			expectView(role("button", { name: "Install on GitHub" })).not.toExist(),
			expectView(role("button", { name: "Continue" })).toBeDisabled(),
		)
	})

	test("Connect authorizes first; only the account picker opens the install page", () => {
		const entered = inner(disconnected(), IntegrationMessage.ClickedConnect())
		expect(entered.integrations.connect.active).toEqual({ provider: "github", attempt: 1 })
		const elsewhere = inner(discovered().model, IntegrationMessage.ClickedInstallGithubElsewhere())
		expect(elsewhere.integrations.connect.active).toEqual({
			provider: "github",
			attempt: 1,
			githubMode: "install",
		})
	})

	test.each([true, false])(
		"GitHub authorization offers every verified account and waits for an explicit choice (opener: %s)",
		(hasOpener) => {
			const returned = discovered(hasOpener)
			expect(returned.commands ?? []).toHaveLength(0)
			expect(returned.model.integrations.connect.active).toBeNull()
			scene(
				{ update: pageUpdate, view },
				given(returned.model),
				expectView(role("button", { name: "Connect personal" })).toExist(),
				expectView(role("button", { name: "Connect acme" })).toExist(),
				expectView(role("button", { name: "Continue" })).toBeDisabled(),
			)
		},
	)

	test("an account GitHub withheld the role for explains the approval and still offers install", () => {
		const returned = inner(
			disconnected(),
			IntegrationMessage.ReceivedConnectMessage({
				provider: "github",
				status: "success",
				message: "Choose an account",
				github: Schema.decodeUnknownSync(GithubInstallationSelection)({
					...selection,
					installations: [],
					needsApproval: ["acme"],
				}),
			}),
		)
		scene(
			{ update: pageUpdate, view },
			given(returned),
			expectView(text("No GitHub account is ready to connect yet.")).toExist(),
			expectView(text(/approve the app's pending permission request/)).toExist(),
			expectView(role("button", { name: "Install on another GitHub account" })).toExist(),
			expectView(role("button", { name: "Continue" })).toBeDisabled(),
		)
	})

	test("an authorization failure ends the waiting state and keeps recovery available", () => {
		const started = inner(disconnected(), IntegrationMessage.ClickedConnect())
		const failed = inner(
			started,
			IntegrationMessage.ReceivedConnectMessage({
				provider: "github",
				status: "error",
				message: "No installations found.",
			}),
		)
		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(text("Waiting for GitHub to send you back…")).not.toExist(),
			expectView(role("button", { name: "Connect GitHub" })).toExist(),
		)
	})

	test("choosing an account connects that account once and refreshes its real status", () => {
		const picked = pageUpdate(
			discovered().model,
			Message.GotIntegrationsMessage({
				message: IntegrationMessage.ClickedSelectGithubInstallation({ installationId: "202" }),
			}),
		)
		expect(picked.commands?.map(({ name, args }) => ({ name, args }))).toEqual([
			{ name: "SelectGithubInstallation", args: { state: "selection-1", installationId: "202" } },
		])
		expect(
			pageUpdate(
				picked.model,
				Message.GotIntegrationsMessage({
					message: IntegrationMessage.ClickedSelectGithubInstallation({ installationId: "101" }),
				}),
			).commands ?? [],
		).toHaveLength(0)
		scene(
			{ update: pageUpdate, view },
			given(picked.model),
			expectView(role("button", { name: "Connect personal" })).toBeDisabled(),
			expectView(role("button", { name: "Connect acme" })).toBeDisabled(),
		)
		const connected = pageUpdate(
			picked.model,
			Message.GotIntegrationsMessage({
				message: IntegrationMessage.CompletedSelectGithubInstallation({
					state: "selection-1",
					installationId: "202",
					failure: null,
				}),
			}),
		)
		expect(connected.commands?.map(({ name }) => name)).toContain("TrackIntegrationConnected")
		expect(connected.commands?.map(({ name }) => name)).toContain("LoadIntegrationsGithubStatus")
		const refreshed = inner(
			connected.model,
			IntegrationMessage.CompletedLoadGithub({
				key: connected.model.integrations.statuses.github.key ?? "",
				result: Result.succeed(status()),
			}),
		)
		scene(
			{ update: pageUpdate, view },
			given(refreshed),
			expectView(text("Installed on acme with 2 repositories.")).toExist(),
			expectView(role("button", { name: "Continue" })).not.toBeDisabled(),
		)
	})

	test("a consumed or expired choice returns to authorization instead of retrying the old state", () => {
		const picked = inner(
			discovered().model,
			IntegrationMessage.ClickedSelectGithubInstallation({ installationId: "202" }),
		)
		const failed = pageUpdate(
			picked,
			Message.GotIntegrationsMessage({
				message: IntegrationMessage.CompletedSelectGithubInstallation({
					state: "selection-1",
					installationId: "202",
					failure: toLoadFailure(
						new IntegrationsValidationError({ message: "Connection expired." }),
					),
				}),
			}),
		)
		expect(failed.commands ?? []).toHaveLength(0)
		scene(
			{ update: pageUpdate, view },
			given(failed.model),
			expectView(role("button", { name: "Connect acme" })).not.toExist(),
			expectView(role("button", { name: "Connect GitHub" })).toExist(),
			expectView(role("button", { name: "Continue" })).toBeDisabled(),
		)
	})

	test.each([
		{ connected: true, state: "connected" },
		{ connected: false, state: "disconnected" },
	])("selection keeps reading until repository discovery finishes ($state)", (initial) => {
		const picked = inner(
			discovered().model,
			IntegrationMessage.ClickedSelectGithubInstallation({ installationId: "202" }),
		)
		const saved = inner(
			picked,
			IntegrationMessage.CompletedSelectGithubInstallation({
				state: "selection-1",
				installationId: "202",
				failure: null,
			}),
		)
		const delayed = inner(
			saved,
			IntegrationMessage.CompletedLoadGithub({
				key: saved.integrations.statuses.github.key ?? "",
				result: Result.succeed(
					status({
						...initial,
						repositories: [],
						repositoryDiscovery: { _tag: "Pending", requestId: "discovery-1" },
					}),
				),
			}),
		)
		const isPolling = (model: Model) =>
			subscriptions.githubPoll.modelToDependencies({ model: model.integrations, context }).isPolling
		expect(isPolling(delayed)).toBe(true)
		scene(
			{ update: pageUpdate, view },
			given(delayed),
			expectView(text("Discovering repositories…")).toExist(),
			expectView(text("No repositories granted")).not.toExist(),
		)
		const ticked = pageUpdate(
			delayed,
			Message.GotIntegrationsMessage({ message: IntegrationMessage.TickedGithubPoll() }),
		)
		expect(ticked.commands?.map(({ name }) => name)).toContain("LoadIntegrationsGithubStatus")
		const syncing = inner(
			ticked.model,
			IntegrationMessage.CompletedLoadGithub({
				key: ticked.model.integrations.statuses.github.key ?? "",
				result: Result.succeed(
					status({
						repositories: [repo("1", "web", "backfilling")],
						repositoryDiscovery: { _tag: "Complete", requestId: "discovery-1" },
					}),
				),
			}),
		)
		expect(isPolling(syncing)).toBe(true)
		const ready = inner(
			syncing,
			IntegrationMessage.CompletedLoadGithub({
				key: syncing.integrations.statuses.github.key ?? "",
				result: Result.succeed(
					status({
						repositories: [repo("1", "web", "ready")],
						repositoryDiscovery: { _tag: "Complete", requestId: "discovery-1" },
					}),
				),
			}),
		)
		expect(isPolling(ready)).toBe(false)
	})

	test("a completed empty discovery settles to no grants instead of polling forever", () => {
		const complete = withStatus(
			status({ repositories: [], repositoryDiscovery: { _tag: "Complete", requestId: "discovery-1" } }),
		)
		expect(
			subscriptions.githubPoll.modelToDependencies({ model: complete.integrations, context }).isPolling,
		).toBe(false)
		scene(
			{ update: pageUpdate, view },
			given(complete),
			click(role("button", { name: "Continue" })),
			Command.resolve(ScrollToTop, Message.CompletedScrollToTop()),
			expectView(text("No repositories granted")).toExist(),
			expectView(text("Discovering repositories")).not.toExist(),
		)
	})

	test("failed discovery stops polling and can authorize again while already connected", () => {
		const failed = withStatus(
			status({
				repositories: [repo("1", "web", "backfilling")],
				repositoryDiscovery: {
					_tag: "Failed",
					requestId: "discovery-1",
					message: "GitHub rate limit exhausted. Reconnect to retry.",
				},
			}),
		)
		expect(
			subscriptions.githubPoll.modelToDependencies({ model: failed.integrations, context }).isPolling,
		).toBe(false)
		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(text("GitHub rate limit exhausted. Reconnect to retry.")).toExist(),
			expectView(role("button", { name: "Reconnect GitHub" })).toExist(),
		)
		const returned = inner(
			failed,
			IntegrationMessage.ReceivedConnectMessage({
				provider: "github",
				status: "success",
				message: "Choose an account",
				github: selection,
			}),
		)
		scene(
			{ update: pageUpdate, view },
			given(returned),
			expectView(role("button", { name: "Connect acme" })).toExist(),
			expectView(role("button", { name: "Continue" })).toBeDisabled(),
		)
	})

	test("retrying from Go live returns to Connect and can finish the selected account", () => {
		const failed = withStatus(
			status({
				repositories: [],
				repositoryDiscovery: {
					_tag: "Failed",
					requestId: "discovery-1",
					message: "GitHub rate limit exhausted.",
				},
			}),
		)
		scene(
			{ update: pageUpdate, view },
			given(failed),
			click(role("button", { name: "Continue" })),
			Command.resolve(ScrollToTop, Message.CompletedScrollToTop()),
			expectView(text("Repository discovery failed")).toExist(),
			click(role("button", { name: "Reconnect GitHub" })),
			Subscription.emit(
				Message.GotIntegrationsMessage({
					message: IntegrationMessage.ReceivedConnectMessage({
						provider: "github",
						status: "success",
						message: "Choose an account",
						github: selection,
					}),
				}),
			),
			expectView(role("button", { name: "Connect acme" })).toExist(),
			expectView(role("listitem", { current: "step", name: "Connect" })).toExist(),
			Command.resolve(ScrollToTop, Message.CompletedScrollToTop()),
			click(role("button", { name: "Connect acme" })),
			Command.resolve(
				SelectGithubInstallation,
				IntegrationMessage.CompletedSelectGithubInstallation({
					state: selection.state,
					installationId: "202",
					failure: null,
				}),
			),
			Command.expectHas(LoadGithub),
			expectView(role("button", { name: "Connect acme" })).not.toExist(),
			Command.resolve(TrackConnected, IntegrationMessage.CompletedTrackConnected()),
			(simulation: SceneSimulation<Model, Message, PageOutMessage>) =>
				Command.resolve(
					LoadGithub,
					IntegrationMessage.CompletedLoadGithub({
						key: requestKeyOf(simulation.commands, LoadGithub.name),
						result: Result.succeed(
							status({
								repositories: [],
								repositoryDiscovery: { _tag: "Pending", requestId: "discovery-2" },
							}),
						),
					}),
				)(simulation),
			(simulation: SceneSimulation<Model, Message, PageOutMessage>) =>
				Command.resolve(
					FetchSourcesList,
					Message.CompletedFetchList({
						key: requestKeyOf(simulation.commands, FetchSourcesList.name),
						result: Result.succeed([]),
					}),
				)(simulation),
			expectView(text("Discovering repositories…")).toExist(),
		)
	})

	test("once installed, Connect names the installation and Go live tracks the sync", () => {
		scene(
			{ update: pageUpdate, view },
			given(withStatus(status())),
			expectView(text("Installed on acme with 2 repositories.")).toExist(),
			click(role("button", { name: "Continue" })),
			Command.resolve(ScrollToTop, Message.CompletedScrollToTop()),
			expectView(role("listitem", { name: "Installed on acme" })).toExist(),
			expectView(role("listitem", { current: "step", name: "Go live" })).toExist(),
			expectView(text("Repositories syncing")).toExist(),
			expectView(text("acme/api")).toExist(),
		)
	})

	test("every repository synced makes the source live; a failed sync needs attention", () => {
		scene(
			{ update: pageUpdate, view },
			given(withStatus(status({ repositories: [repo("1", "web", "ready")] }))),
			click(role("button", { name: "Continue" })),
			Command.resolve(ScrollToTop, Message.CompletedScrollToTop()),
			expectView(role("listitem", { name: "Live" })).toExist(),
			expectView(text("GitHub is live")).toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(
				withStatus(status({ repositories: [repo("1", "web", "error", "branch release is gone")] })),
			),
			click(role("button", { name: "Continue" })),
			Command.resolve(ScrollToTop, Message.CompletedScrollToTop()),
			expectView(role("listitem", { name: "Go live: needs attention" })).toExist(),
			expectView(text("0 synced, 1 sync failed: branch release is gone")).toExist(),
		)
	})
})
