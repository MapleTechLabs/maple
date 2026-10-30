import { OrgId } from "@maple/domain"
import { ErrorIssueId, GithubIntegrationStatus } from "@maple/domain/http"
import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { describe, expect, test } from "vitest"
import * as Dialog from "../../../ui/dialog"
import * as Select from "../../../ui/select"
import type { PageContext } from "../../contract"
import { githubOf } from "./attach"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const issueId = Schema.decodeSync(ErrorIssueId)("0199a004-0000-7000-8000-000000000001")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC" }

const repository = (fullName: string, index: number) => ({
	id: `0199a005-0000-7000-8000-00000000000${index}`,
	fullName,
	htmlUrl: `https://github.com/${fullName}`,
	isPrivate: true,
	status: "active",
	syncStatus: "ready",
	lastSyncedAt: 0,
	lastSyncError: null,
	trackedBranch: "main",
	branches: [],
	prReviewEnabled: false,
})

const status = Schema.decodeUnknownSync(GithubIntegrationStatus)({
	connected: true,
	state: "connected",
	accountLogin: "acme-shop",
	accountType: "organization",
	repositorySelection: "selected",
	ciTracesEnabled: true,
	repositoryDiscovery: null,
	repositories: [repository("acme-shop/shop", 1), repository("acme-shop/storefront", 2)],
})

/** The issue page with the GitHub App answered on two repositories. */
const connected = (): Model => {
	const model = init({ issueId, search: {} }, context).model
	return { ...model, githubStatus: { key: "status", data: AsyncData.Success({ data: status }) } }
}

describe("attach dialog repository", () => {
	test("the first repository is picked until another one is chosen", () => {
		expect(githubOf(connected()).repository).toBe("acme-shop/shop")
	})

	test("picking a repository asks for its pull requests and clears the search", () => {
		const model = { ...connected(), attachDraft: "#12" }
		const opened = update(
			model,
			Message.GotRepositorySelectMessage({
				message: Select.Message.ClickedTrigger({ selectedIndex: 0 }),
			}),
			context,
		)
		const picked = update(
			opened.model,
			Message.GotRepositorySelectMessage({
				message: Select.Message.SelectedItem({ value: "acme-shop/storefront", index: 1 }),
			}),
			context,
		)
		expect(githubOf(picked.model).repository).toBe("acme-shop/storefront")
		expect(picked.model.attachDraft).toBe("")
		expect((picked.commands ?? []).map((command) => command.name)).toContain("FetchVcsPullRequests")
	})

	test("closing the dialog drops the picked repository; reopening shows the suggested one", () => {
		const opened = update(connected(), Message.ClickedAttach(), context).model
		const shown = update(
			opened,
			Message.GotRepositorySelectMessage({
				message: Select.Message.ClickedTrigger({ selectedIndex: 0 }),
			}),
			context,
		)
		const picked = update(
			shown.model,
			Message.GotRepositorySelectMessage({
				message: Select.Message.SelectedItem({ value: "acme-shop/storefront", index: 1 }),
			}),
			context,
		).model
		const closed = update(
			picked,
			Message.GotAttachDialogMessage({ message: Dialog.Message.ClickedClose() }),
			context,
		)
		expect(githubOf(closed.model).repository).toBe("acme-shop/shop")
	})
})
