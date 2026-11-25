import { githubAuditCategoryStates } from "@maple/domain/github-audit"
import * as Policy from "@maple/domain/policy"
import { OrgId } from "@maple/domain"
import { GithubIntegrationStatus, GithubInstallationSelection } from "@maple/domain/http"
import { Result, Schema, Array as Arr } from "effect"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { PageOutMessage, type PageContext } from "../contract"
import { GithubMessage } from "./github"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { auditCategoryShown, auditLogShown, ciTracesShown } from "./update-github"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const github = (message: GithubMessage) => Message.GotGithubMessage({ message })
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)
const REPO = "0199a005-0000-7000-8000-000000000001"

const status = Schema.decodeSync(GithubIntegrationStatus)({
	connected: true,
	state: "connected",
	accountLogin: "acme-shop",
	accountType: "organization",
	repositorySelection: "selected",
	ciTracesEnabled: true,
	auditLogEnabled: true,
	auditCategories: githubAuditCategoryStates({}),
	repositoryDiscovery: null,
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
const repoId = Arr.getUnsafe(status.repositories, 0).id

describe("github card", () => {
	test("failed repository discovery offers authorization and shows its account choice on a connected card", () => {
		const model = loaded()
		const failed = pageUpdate(
			model,
			Message.CompletedLoadGithub({
				key: model.statuses.github.key ?? "",
				result: Result.succeed(
					new GithubIntegrationStatus({
						...status,
						repositories: [],
						repositoryDiscovery: {
							_tag: "Failed",
							requestId: "discovery-1",
							message: "GitHub rate limit exhausted.",
						},
					}),
				),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(text("GitHub rate limit exhausted.")).toExist(),
			expectView(role("button", { name: "Reconnect GitHub" })).toExist(),
		)
		const choices = pageUpdate(
			failed,
			Message.ReceivedConnectMessage({
				provider: "github",
				status: "success",
				message: "Choose an account",
				github: new GithubInstallationSelection({
					state: "selection-2",
					needsApproval: [],
					unavailable: 0,
					installUrl: "https://github.test/apps/maple/installations/new?state=install-1",
					installations: [
						{
							id: "202",
							accountLogin: "acme-shop",
							accountType: "organization",
							repositorySelection: "selected",
						},
					],
				}),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(choices),
			expectView(role("button", { name: "Connect acme-shop" })).toExist(),
			expectView(text(/Choosing a different account replaces it/)).not.toExist(),
		)
	})
	test("a failed rediscovery keeps the synced repositories listed under its error", () => {
		const model = loaded()
		const failed = pageUpdate(
			model,
			Message.CompletedLoadGithub({
				key: model.statuses.github.key ?? "",
				result: Result.succeed(
					new GithubIntegrationStatus({
						...status,
						repositoryDiscovery: {
							_tag: "Failed",
							requestId: "discovery-2",
							message: "GitHub rate limit exhausted.",
						},
					}),
				),
			}),
		).model
		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(text("GitHub rate limit exhausted.")).toExist(),
			expectView(text("acme-shop/shop")).toExist(),
		)
	})

	test("the CI traces switch flips optimistically, writes once, and reverts on failure", () => {
		const model = loaded()
		scene({ update: pageUpdate, view }, given(model), expectView(role("switch")).toExist())
		const toggled = pageUpdate(model, github(GithubMessage.ToggledCiTraces()))
		expect(ciTracesShown(toggled.model)).toBe(false)
		expect(names(toggled.commands)).toEqual(["SetGithubCiTraces"])
		expect(names(pageUpdate(toggled.model, github(GithubMessage.ToggledCiTraces())).commands)).toEqual([])
		const failed = pageUpdate(
			toggled.model,
			github(GithubMessage.CompletedCiTraces({ enabled: false, failure: toLoadFailure("x") })),
		)
		expect(ciTracesShown(failed.model)).toBe(true)
	})

	test("the features list switches CI traces here and links pull request reviews to their repositories", () => {
		const model = loaded()
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(role("switch", { name: "CI traces and logs" })).toHaveAttr("aria-checked", "true"),
			expectView(role("link", { name: "Choose repositories" })).toHaveAttr(
				"href",
				"/code-review/settings",
			),
			expectView(text("0 of 1 repository")).toExist(),
		)
		const toggled = pageUpdate(model, github(GithubMessage.ToggledCiTraces()))
		expect(Arr.map(toggled.commands ?? [], ({ name, args }) => [name, args])).toEqual([
			["SetGithubCiTraces", { enabled: false }],
		])
		scene(
			{ update: pageUpdate, view },
			given(toggled.model),
			expectView(role("switch", { name: "CI traces and logs" })).toHaveAttr("aria-checked", "false"),
			expectView(role("switch", { name: "CI traces and logs" })).toBeDisabled(),
		)
	})

	test("the audit log switch turns GitHub's audit events off, and reverts when the write fails", () => {
		const model = loaded()
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(role("switch", { name: "Audit log" })).toHaveAttr("aria-checked", "true"),
		)
		const toggled = pageUpdate(model, github(GithubMessage.ToggledAuditLog()))
		expect(Arr.map(toggled.commands ?? [], ({ name, args }) => [name, args])).toEqual([
			["SetGithubAuditLog", { enabled: false }],
		])
		expect(names(pageUpdate(toggled.model, github(GithubMessage.ToggledAuditLog())).commands)).toEqual([])
		scene(
			{ update: pageUpdate, view },
			given(toggled.model),
			expectView(role("switch", { name: "Audit log" })).toHaveAttr("aria-checked", "false"),
			expectView(role("switch", { name: "Audit log" })).toBeDisabled(),
			// The other switch stays as it was.
			expectView(role("switch", { name: "CI traces and logs" })).toHaveAttr("aria-checked", "true"),
		)
		const failed = pageUpdate(
			toggled.model,
			github(GithubMessage.CompletedAuditLog({ enabled: false, failure: toLoadFailure("x") })),
		)
		expect(auditLogShown(failed.model)).toBe(true)
	})

	test("a superseded status answer leaves the saved audit log value standing; the current one settles it", () => {
		const toggled = pageUpdate(loaded(), github(GithubMessage.ToggledAuditLog()))
		const saved = pageUpdate(
			toggled.model,
			github(GithubMessage.CompletedAuditLog({ enabled: false, failure: null })),
		)
		// An older read lands after the save, still saying on: the switch keeps showing off.
		const stale = pageUpdate(
			saved.model,
			Message.CompletedLoadGithub({ key: "superseded", result: Result.succeed(status) }),
		)
		expect(auditLogShown(stale.model)).toBe(false)
		// The current read says off: the server's value takes over.
		const current = pageUpdate(
			stale.model,
			Message.CompletedLoadGithub({
				key: stale.model.statuses.github.key ?? "",
				result: Result.succeed(new GithubIntegrationStatus({ ...status, auditLogEnabled: false })),
			}),
		)
		expect(current.model.githubCard.auditLog).toBe(null)
		expect(auditLogShown(current.model)).toBe(false)
	})

	test("the audit log lists its categories with their defaults, and saves one category at a time", () => {
		const model = loaded()
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(role("switch", { name: "Force pushes" })).toHaveAttr("aria-checked", "true"),
			expectView(role("switch", { name: "Security alerts" })).toHaveAttr("aria-checked", "false"),
			expectView(role("switch", { name: "Refused pushes" })).toHaveAttr("aria-checked", "true"),
			expectView(text("8 of 14 categories")).toExist(),
		)
		const toggled = pageUpdate(
			model,
			github(GithubMessage.ToggledAuditCategory({ id: "securityAlerts" })),
		)
		expect(Arr.map(toggled.commands ?? [], ({ name, args }) => [name, args])).toEqual([
			["SetGithubAuditCategory", { id: "securityAlerts", enabled: true }],
		])
		// A second click while the write is in flight does nothing; another category still saves.
		expect(
			names(
				pageUpdate(
					toggled.model,
					github(GithubMessage.ToggledAuditCategory({ id: "securityAlerts" })),
				).commands,
			),
		).toEqual([])
		expect(
			names(
				pageUpdate(toggled.model, github(GithubMessage.ToggledAuditCategory({ id: "forks" })))
					.commands,
			),
		).toEqual(["SetGithubAuditCategory"])
		scene(
			{ update: pageUpdate, view },
			given(toggled.model),
			expectView(role("switch", { name: "Security alerts" })).toHaveAttr("aria-checked", "true"),
			expectView(role("switch", { name: "Security alerts" })).toBeDisabled(),
		)
		// A failed write puts the switch back.
		const failed = pageUpdate(
			toggled.model,
			github(
				GithubMessage.CompletedAuditCategory({
					id: "securityAlerts",
					enabled: true,
					failure: toLoadFailure("x"),
				}),
			),
		)
		expect(auditCategoryShown(failed.model, "securityAlerts")).toBe(false)
		// A saved one holds until the server's read replaces it.
		const saved = pageUpdate(
			toggled.model,
			github(
				GithubMessage.CompletedAuditCategory({ id: "securityAlerts", enabled: true, failure: null }),
			),
		)
		expect(auditCategoryShown(saved.model, "securityAlerts")).toBe(true)
		const current = pageUpdate(
			saved.model,
			Message.CompletedLoadGithub({
				key: saved.model.statuses.github.key ?? "",
				result: Result.succeed(
					new GithubIntegrationStatus({
						...status,
						auditCategories: githubAuditCategoryStates({ securityAlerts: true }),
					}),
				),
			}),
		)
		expect(current.model.githubCard.auditCategories).toEqual([])
		expect(auditCategoryShown(current.model, "securityAlerts")).toBe(true)
	})

	test("the categories hide while the audit log is off", () => {
		const off = pageUpdate(
			loaded(),
			Message.CompletedLoadGithub({
				key: loaded().statuses.github.key ?? "",
				result: Result.succeed(new GithubIntegrationStatus({ ...status, auditLogEnabled: false })),
			}),
		)
		scene(
			{ update: pageUpdate, view },
			given(off.model),
			expectView(role("switch", { name: "Audit log" })).toHaveAttr("aria-checked", "false"),
			expectView(role("switch", { name: "Force pushes" })).not.toExist(),
		)
	})

	test("a member who cannot manage integrations sees both switches but cannot flip them", () => {
		const member = { ...loaded(), grants: Policy.grantsOf(["org:member"]) }
		scene(
			{ update: pageUpdate, view },
			given(member),
			expectView(role("switch", { name: "Audit log" })).toBeDisabled(),
			expectView(role("switch", { name: "CI traces and logs" })).toBeDisabled(),
		)
	})

	test("picking another branch confirms first, then saves and polls the backfill", () => {
		const model = loaded()
		const picked = pageUpdate(model, github(GithubMessage.ClickedBranch({ repoId, branch: "release" })))
		expect(picked.model.githubCard.pendingBranch).toEqual({ repoId, branch: "release" })
		expect(picked.model.githubCard.branchDialog.isOpen).toBe(true)
		const confirmed = pageUpdate(picked.model, github(GithubMessage.ConfirmedBranch()))
		expect(names(confirmed.commands)).toContain("SetGithubTrackedBranch")
		expect(confirmed.model.githubCard.branchDialog.isOpen).toBe(true)
		const done = pageUpdate(
			confirmed.model,
			github(
				GithubMessage.CompletedTrackedBranch({
					repoId,
					branch: "release",
					backfillQueued: true,
					failure: null,
				}),
			),
		)
		expect(done.model.githubCard.isForcePolling).toBe(true)
		expect(done.model.githubCard.branchDialog.isOpen).toBe(false)
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({
				type: "success",
				title: "Now tracking release, re-syncing commits…",
				description: "",
			}),
		)
		expect(
			names(
				pageUpdate(model, github(GithubMessage.ClickedBranch({ repoId, branch: "main" }))).commands,
			),
		).not.toContain("SetGithubTrackedBranch")
	})

	test("a second repository can change branch while the first one's save is in flight", () => {
		const other = "0199a005-0000-7000-8000-000000000002"
		const first = Arr.getUnsafe(status.repositories, 0)
		const twoRepos = Schema.decodeSync(GithubIntegrationStatus)({
			...Schema.encodeSync(GithubIntegrationStatus)(status),
			repositories: [first, { ...first, id: other, fullName: "acme-shop/api" }],
		})
		const base = init({ search: { integration: "github" } }, context).model
		const model = pageUpdate(
			base,
			Message.CompletedLoadGithub({
				key: base.statuses.github.key ?? "",
				result: Result.succeed(twoRepos),
			}),
		).model
		const otherId = twoRepos.repositories[1]?.id ?? repoId
		const confirm = (from: Model, id: typeof repoId) =>
			pageUpdate(
				pageUpdate(from, github(GithubMessage.ClickedBranch({ repoId: id, branch: "release" })))
					.model,
				github(GithubMessage.ConfirmedBranch()),
			)
		const savingFirst = confirm(model, repoId)
		const savingBoth = confirm(savingFirst.model, otherId)
		expect(names(savingBoth.commands)).toContain("SetGithubTrackedBranch")
		expect(names(confirm(savingBoth.model, otherId).commands)).not.toContain("SetGithubTrackedBranch")
	})

	test("refresh re-reads the status and spins until its timer", () => {
		const refreshed = pageUpdate(loaded(), github(GithubMessage.ClickedGithubRefresh()))
		expect(names(refreshed.commands)).toEqual(
			expect.arrayContaining(["LoadIntegrationsGithubStatus", "SpinGithubRefresh"]),
		)
		const stopped = pageUpdate(
			refreshed.model,
			github(GithubMessage.CompletedGithubRefreshSpin({ version: 1 })),
		)
		expect(stopped.model.githubCard.isRefreshing).toBe(false)
	})
})
