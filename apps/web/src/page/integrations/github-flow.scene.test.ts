import { OrgId } from "@maple/domain"
import { GithubIntegrationStatus } from "@maple/domain/http"
import { Result, Schema } from "effect"
import { click, Command, expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, test } from "vitest"
import type { PageContext } from "../contract"
import { ScrollToTop } from "../sources/new/command"
import { Message } from "../sources/new/message"
import type { Model } from "../sources/new/model"
import { init, update } from "../sources/new/update"
import { view as pageView } from "../sources/new/view"
import { Message as IntegrationMessage } from "./message"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_acme"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const inner = (model: Model, message: IntegrationMessage) =>
	pageUpdate(model, Message.GotIntegrationsMessage({ message })).model

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
			expectView(role("button", { name: "Install on GitHub" })).toExist(),
			expectView(role("button", { name: "Continue" })).toBeDisabled(),
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
