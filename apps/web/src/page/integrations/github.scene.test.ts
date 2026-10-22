import { OrgId } from "@maple/domain"
import { GithubIntegrationStatus } from "@maple/domain/http"
import { Result, Schema } from "effect"
import { expect as expectView, given, role, scene, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../data/load-failure"
import { PageOutMessage, type PageContext } from "../contract"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { ciTracesShown } from "./update-github"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)
const REPO = "0199a005-0000-7000-8000-000000000001"

const status = Schema.decodeUnknownSync(GithubIntegrationStatus)({
	connected: true,
	state: "connected",
	accountLogin: "acme-shop",
	accountType: "organization",
	repositorySelection: "selected",
	ciTracesEnabled: true,
	repositories: [
		{
			id: REPO,
			fullName: "acme-shop/shop",
			htmlUrl: "https://github.com/acme-shop/shop",
			isPrivate: true,
			status: "active",
			syncStatus: "ready",
			lastSyncedAt: 1,
			lastSyncError: null,
			trackedBranch: "main",
			branches: [
				{ name: "main", isDefault: true },
				{ name: "release", isDefault: false },
			],
			prReviewEnabled: false,
		},
	],
})

const loaded = (): Model => {
	const model = init({ search: { integration: "github" } }, context).model
	return pageUpdate(
		model,
		Message.CompletedLoadGithub({ key: model.statuses.github.key ?? "", result: Result.succeed(status) }),
	).model
}
const repoId = status.repositories[0]?.id ?? Schema.decodeSync(Schema.String)(REPO)

describe("github card", () => {
	test("the CI traces switch flips optimistically, writes once, and reverts on failure", () => {
		const model = loaded()
		scene({ update: pageUpdate, view }, given(model), expectView(role("switch")).toExist())
		const toggled = pageUpdate(model, Message.ToggledCiTraces())
		expect(ciTracesShown(toggled.model)).toBe(false)
		expect(names(toggled.commands)).toEqual(["SetGithubCiTraces"])
		expect(names(pageUpdate(toggled.model, Message.ToggledCiTraces()).commands)).toEqual([])
		const failed = pageUpdate(
			toggled.model,
			Message.CompletedCiTraces({ enabled: false, failure: toLoadFailure("x") }),
		)
		expect(ciTracesShown(failed.model)).toBe(true)
	})

	test("picking another branch confirms first, then saves and polls the backfill", () => {
		const model = loaded()
		const picked = pageUpdate(model, Message.ClickedBranch({ repoId, branch: "release" }))
		expect(picked.model.githubCard.pendingBranch).toEqual({ repoId, branch: "release" })
		expect(picked.model.githubCard.branchDialog.isOpen).toBe(true)
		const confirmed = pageUpdate(picked.model, Message.ConfirmedBranch())
		expect(names(confirmed.commands)).toContain("SetGithubTrackedBranch")
		const done = pageUpdate(
			confirmed.model,
			Message.CompletedTrackedBranch({
				repoId,
				branch: "release",
				backfillQueued: true,
				failure: null,
			}),
		)
		expect(done.model.githubCard.isForcePolling).toBe(true)
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "success",
				title: "Now tracking release, re-syncing commits…",
				description: "",
			}),
		)
		expect(
			names(pageUpdate(model, Message.ClickedBranch({ repoId, branch: "main" })).commands),
		).not.toContain("SetGithubTrackedBranch")
	})

	test("a second repository can change branch while the first one's save is in flight", () => {
		const other = "0199a005-0000-7000-8000-000000000002"
		const [first] = status.repositories
		const twoRepos = Schema.decodeUnknownSync(GithubIntegrationStatus)({
			...Schema.encodeSync(GithubIntegrationStatus)(status),
			repositories: [first, { ...first, id: other, fullName: "acme-shop/api" }],
		})
		const base = init({ search: { integration: "github" } }, context).model
		const model = pageUpdate(
			base,
			Message.CompletedLoadGithub({ key: base.statuses.github.key ?? "", result: Result.succeed(twoRepos) }),
		).model
		const otherId = twoRepos.repositories[1]?.id ?? repoId
		const confirm = (from: Model, id: typeof repoId) =>
			pageUpdate(pageUpdate(from, Message.ClickedBranch({ repoId: id, branch: "release" })).model, Message.ConfirmedBranch())
		const savingFirst = confirm(model, repoId)
		const savingBoth = confirm(savingFirst.model, otherId)
		expect(names(savingBoth.commands)).toContain("SetGithubTrackedBranch")
		expect(names(confirm(savingBoth.model, otherId).commands)).not.toContain("SetGithubTrackedBranch")
	})

	test("refresh re-reads the status and spins until its timer", () => {
		const refreshed = pageUpdate(loaded(), Message.ClickedGithubRefresh())
		expect(names(refreshed.commands)).toEqual(
			expect.arrayContaining(["LoadIntegrationsGithubStatus", "SpinGithubRefresh"]),
		)
		const stopped = pageUpdate(refreshed.model, Message.CompletedGithubRefreshSpin({ version: 1 }))
		expect(stopped.model.githubCard.isRefreshing).toBe(false)
	})
})
