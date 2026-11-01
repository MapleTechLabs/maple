import { OrgId } from "@maple/domain"
import { DependencyScanForbiddenError, DependencyScanPersistenceError } from "@maple/domain/http"
import type { DependencyFindingsResponse, DependencyScanRepositoriesResponse } from "@maple/domain/http"
import { Result, Schema } from "effect"
import {
	click,
	Command,
	expect as expectView,
	expectOutMessage,
	given,
	role,
	scene,
	text,
	type,
	withViewInputs,
	Mount,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "../../../data/load-failure"
import {
	FINDING_IDS,
	findingsOf,
	neverScannedOf,
	noFindings,
	noRepositories,
	PAYMENTS_ID,
	repositoriesOf,
	rescannedOf,
} from "../../../lab/security-dependencies-fixture"
import { AppRoute, hrefOf } from "../../../route"
import * as Dialog from "../../../ui/dialog"
import * as Field from "../../../ui/field"
import * as Select from "../../../ui/select"
import { type PageContext, PageOutMessage } from "../../contract"
import { UpdateFinding } from "./command"
import { reasonErrorOf } from "./derive"
import { Message, type Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_acme"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const NOW = Date.UTC(2026, 10, 1, 9, 0)
const route = AppRoute.SecurityDependencies()
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)
const apply = (model: Model, messages: ReadonlyArray<(model: Model) => Message>): Model =>
	messages.reduce((current, toMessage) => pageUpdate(current, toMessage(current)).model, model)

const loaded = (
	repositories: DependencyScanRepositoriesResponse = repositoriesOf(NOW),
	findings: DependencyFindingsResponse = findingsOf(NOW),
	isAdmin = true,
): Model =>
	apply(init(route, context).model, [
		() => Message.ReadClock({ nowMs: NOW }),
		() => Message.CompletedReadIsAdmin({ isAdmin }),
		(model) =>
			Message.CompletedFetchRepositories({
				key: model.repositories.key ?? "",
				result: Result.succeed(repositories),
			}),
		(model) =>
			Message.CompletedFetchFindings({
				key: model.findings.key ?? "",
				result: Result.succeed(findings),
			}),
	])

const forbiddenFailure = toLoadFailure(
	new DependencyScanForbiddenError({ message: "Only org admins can triage findings" }),
)
const forbidden = Result.fail(forbiddenFailure)

const mounted = Mount.resolve(Dialog.MountDialog, Dialog.Message.CompletedMountDialog())

const opened = (model: Model, findingId = FINDING_IDS.axios): Model =>
	pageUpdate(model, Message.ClickedFinding({ findingId })).model

describe("security dependencies tab", () => {
	test("entering reads the repositories and the findings", () => {
		expect(names(init(route, context).commands)).toEqual(
			expect.arrayContaining(["SecurityApiDependencyRepositories", "SecurityApiDependencyFindings"]),
		)
	})

	test("while loading, the tab strip shows and the content is busy", () => {
		scene(
			{ update: pageUpdate, view },
			given(init(route, context).model),
			expectView(role("link", { name: /Dependencies/ })).toExist(),
			expectView(text("Repositories")).toBeAbsent(),
		)
	})

	test("a failed read shows the error with a retry that reads again", () => {
		const failed = apply(init(route, context).model, [
			(model) =>
				Message.CompletedFetchRepositories({
					key: model.repositories.key ?? "",
					result: Result.fail(toLoadFailure(new Error("unexpected body"))),
				}),
		])
		scene(
			{ update: pageUpdate, view },
			given(failed),
			expectView(text("Couldn't load dependency scans")).toExist(),
			expectView(role("button", { name: "Try again" })).toExist(),
		)
		expect(names(pageUpdate(failed, Message.ClickedRetry()).commands)).toContain(
			"SecurityApiDependencyRepositories",
		)
	})

	test("with no connected repository, the tab is the GitHub on-ramp", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(noRepositories, noFindings)),
			expectView(text("Connect a repository to scan its dependencies")).toExist(),
			expectView(role("link", { name: "Connect GitHub" })).toHaveAttr(
				"href",
				hrefOf(AppRoute.Integrations({ search: {} })),
			),
			expectView(text("Vulnerable packages")).toBeAbsent(),
		)
	})

	test("connected but never scanned says the first scan is coming and offers Scan now", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(neverScannedOf(NOW), noFindings)),
			expectView(text("First scan is on its way")).toExist(),
			expectView(text("Not scanned yet")).toExist(),
			expectView(text("Vulnerable packages")).toBeAbsent(),
		)
	})

	test("names the busiest service running each finding, and says when one is not deployed", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded(repositoriesOf(NOW), findingsOf(NOW))),
			expectView(text("api-gateway +1")).toExist(),
			expectView(text("2.6M spans/day")).toExist(),
			expectView(text("payments-worker")).toExist(),
			expectView(text("Not running")).toExist(),
			expectView(text(/vcs\.ref\.head\.revision/)).toBeAbsent(),
		)
	})

	test("says a running commit is not scanned yet, not absent and not scanning, before any scan of it", () => {
		const repositories = repositoriesOf(NOW)
		scene(
			{ update: pageUpdate, view },
			given(
				loaded(
					{
						repositories: repositories.repositories.map((repository) =>
							repository.id === PAYMENTS_ID
								? {
										...repository,
										runningCommits: repository.runningCommits.map((commit) => ({
											...commit,
											scanStatus: null,
										})),
									}
								: repository,
						),
					},
					{
						...findingsOf(NOW),
						findings: findingsOf(NOW).findings.map((finding) => ({ ...finding, production: [] })),
					},
				),
			),
			expectView(text("Not scanned yet")).toExist(),
			expectView(text("Scanning")).toBeAbsent(),
			expectView(text("api-gateway +1")).toBeAbsent(),
		)
	})

	test("says a finding is being scanned, not absent, while a running commit's scan runs", () => {
		const repositories = repositoriesOf(NOW)
		scene(
			{ update: pageUpdate, view },
			given(
				loaded(
					{
						repositories: repositories.repositories.map((repository) =>
							repository.id === PAYMENTS_ID
								? {
										...repository,
										runningCommits: repository.runningCommits.map((commit) => ({
											...commit,
											scanStatus: "running" as const,
										})),
									}
								: repository,
						),
					},
					{
						...findingsOf(NOW),
						findings: findingsOf(NOW).findings.map((finding) => ({ ...finding, production: [] })),
					},
				),
			),
			expectView(text("Scanning")).toExist(),
			expectView(text("api-gateway +1")).toBeAbsent(),
		)
	})

	test("says a running commit's scan failed instead of claiming it is still scanning", () => {
		const repositories = repositoriesOf(NOW)
		scene(
			{ update: pageUpdate, view },
			given(
				loaded(
					{
						repositories: repositories.repositories.map((repository) =>
							repository.id === PAYMENTS_ID
								? {
										...repository,
										runningCommits: repository.runningCommits.map((commit) => ({
											...commit,
											scanStatus: "failed" as const,
										})),
									}
								: repository,
						),
					},
					{
						...findingsOf(NOW),
						findings: findingsOf(NOW).findings.map((finding) => ({ ...finding, production: [] })),
					},
				),
			),
			expectView(text("Scan failed")).toExist(),
			expectView(text("Scanning")).toBeAbsent(),
		)
	})

	test("does not call a repository clean when its only scan failed", () => {
		const repositories = repositoriesOf(NOW)
		scene(
			{ update: pageUpdate, view },
			given(
				loaded(
					{
						repositories: repositories.repositories.map((repository) =>
							repository.latestScan === null
								? repository
								: {
										...repository,
										latestScan: { ...repository.latestScan, status: "failed" as const },
									},
						),
					},
					noFindings,
				),
			),
			expectView(text("No known vulnerable packages")).toBeAbsent(),
		)
	})

	test("does not call a repository clean when its scan could not read a lockfile", () => {
		const repositories = repositoriesOf(NOW)
		scene(
			{ update: pageUpdate, view },
			given(
				loaded(
					{
						repositories: repositories.repositories.map((repository) =>
							repository.latestScan === null
								? repository
								: {
										...repository,
										latestScan: {
											...repository.latestScan,
											status: "completed" as const,
											lockfiles: repository.latestScan.lockfiles.map((lockfile) => ({
												...lockfile,
												status: "too_large" as const,
											})),
										},
									},
						),
					},
					noFindings,
				),
			),
			expectView(text("No known vulnerable packages")).toBeAbsent(),
		)
	})

	test("does not call a repository clean when its scan left advisories unread", () => {
		const repositories = repositoriesOf(NOW)
		scene(
			{ update: pageUpdate, view },
			given(
				loaded(
					{
						repositories: repositories.repositories.map((repository) =>
							repository.latestScan === null
								? repository
								: {
										...repository,
										latestScan: {
											...repository.latestScan,
											status: "completed" as const,
											error: "612 known vulnerabilities past the 500 a scan reads were left out",
											lockfiles: repository.latestScan.lockfiles.map((lockfile) => ({
												...lockfile,
												status: "parsed" as const,
											})),
										},
									},
						),
					},
					noFindings,
				),
			),
			expectView(text("No known vulnerable packages")).toBeAbsent(),
		)
	})

	test("says Unknown, not Not running, when more commits ran than were read", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				loaded(repositoriesOf(NOW), {
					...findingsOf(NOW),
					production: { ...findingsOf(NOW).production, complete: false },
				}),
			),
			expectView(text("Not running")).toBeAbsent(),
			expectView(text("Unknown")).toExist(),
		)
	})

	test("caps a triage reason as the API does, untrimmed", () => {
		expect(reasonErrorOf(" ".repeat(10) + "x".repeat(495))).not.toBeNull()
		expect(reasonErrorOf("x".repeat(500))).toBeNull()
		expect(reasonErrorOf("   ")).not.toBeNull()
	})

	test("explains why findings cannot be tied to production when no service reports its commit", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				loaded(repositoriesOf(NOW), {
					...findingsOf(NOW),
					findings: findingsOf(NOW).findings.map((finding) => ({ ...finding, production: [] })),
					production: { available: true, runningServices: 0, linkedServices: 0, complete: true },
				}),
			),
			expectView(text(/vcs\.ref\.head\.revision/)).toExist(),
			expectView(text("Unknown")).toExist(),
			expectView(text("api-gateway +1")).toBeAbsent(),
		)
	})

	test("scanned with nothing open shows the calm clean state", () => {
		// Clean needs every lockfile read; the fixture's unsupported and failed ones are not.
		const allParsed = {
			repositories: repositoriesOf(NOW).repositories.map((repository) =>
				repository.latestScan === null
					? repository
					: {
							...repository,
							latestScan: {
								...repository.latestScan,
								lockfiles: repository.latestScan.lockfiles.map((lockfile) => ({
									...lockfile,
									status: "parsed" as const,
								})),
							},
						},
			),
		}
		const settled = findingsOf(NOW).findings.filter((finding) => finding.status !== "open")
		scene(
			{ update: pageUpdate, view },
			given(loaded(allParsed, { ...findingsOf(NOW), findings: settled })),
			expectView(text("No known vulnerable packages")).toExist(),
			expectView(text("axios")).toBeAbsent(),
		)
	})

	test("the populated tab shows the rail, repository problems and open findings worst first", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded()),
			expectView(text("3 / 3")).toExist(),
			expectView(text("open, and 1 unrated")).toExist(),
			expectView(text(/commit bun\.lock/)).toExist(),
			expectView(text("Line 212: expected a [[package]] table.")).toExist(),
			expectView(role("link", { name: "CVE-2025-27152" })).toHaveAttr(
				"href",
				"https://osv.dev/vulnerability/GHSA-jr5f-v2jv-69x6",
			),
			// An advisory with no CVE alias shows its own id.
			expectView(role("link", { name: "RUSTSEC-2025-0023" })).toExist(),
			expectView(text("No fix yet")).toExist(),
			expectView(text("lodash.template")).toBeAbsent(),
			expectView(text("jsonwebtoken")).toBeAbsent(),
		)
	})

	test("the status filter shows dismissed and fixed findings, and All shows every one", () => {
		const status = (value: string) => () =>
			Message.GotStatusSelectMessage({ message: Select.Message.SelectedItem({ index: 0, value }) })
		scene(
			{ update: pageUpdate, view },
			given(apply(loaded(), [status("dismissed")])),
			expectView(text("lodash.template")).toExist(),
			expectView(text("axios")).toBeAbsent(),
		)
		scene(
			{ update: pageUpdate, view },
			given(apply(loaded(), [status("all")])),
			expectView(text("lodash.template")).toExist(),
			expectView(text("jsonwebtoken")).toExist(),
			expectView(text("axios")).toExist(),
		)
	})

	test("the repository filter keeps one repository's findings", () => {
		const filtered = apply(loaded(), [
			() =>
				Message.GotRepositorySelectMessage({
					message: Select.Message.SelectedItem({ index: 1, value: PAYMENTS_ID }),
				}),
		])
		scene(
			{ update: pageUpdate, view },
			given(filtered),
			expectView(text("axios")).toExist(),
			expectView(text("tokio")).toBeAbsent(),
		)
	})

	test("Scan now requests a scan, then shows it queued and polls until a newer scan finishes", () => {
		const clicked = pageUpdate(loaded(), Message.ClickedScanNow({ repositoryId: PAYMENTS_ID }))
		expect(names(clicked.commands)).toEqual(["SecurityApiScanRepository"])
		expect(
			names(pageUpdate(clicked.model, Message.ClickedScanNow({ repositoryId: PAYMENTS_ID })).commands),
		).toEqual([])
		const queued = pageUpdate(
			clicked.model,
			Message.CompletedScanRequest({
				repositoryId: PAYMENTS_ID,
				result: Result.succeed({ queued: true }),
			}),
		)
		expect(queued.outMessage).toMatchObject({ title: "Scan queued" })
		scene(
			{ update: pageUpdate, view },
			given(queued.model),
			expectView(role("button", { name: "Scan queued" })).toHaveAttr("disabled", "true"),
		)
		const ticked = pageUpdate(queued.model, Message.TickedScanPoll({ nowMs: NOW + 5_000 }))
		expect(names(ticked.commands)).toEqual(["SecurityApiDependencyRepositories"])
		const unchanged = pageUpdate(
			ticked.model,
			Message.CompletedFetchRepositories({
				key: ticked.model.repositories.key ?? "",
				result: Result.succeed(repositoriesOf(NOW)),
			}),
		)
		expect(unchanged.model.pendingScans).toHaveLength(1)
		const again = pageUpdate(unchanged.model, Message.TickedScanPoll({ nowMs: NOW + 10_000 }))
		const finished = pageUpdate(
			again.model,
			Message.CompletedFetchRepositories({
				key: again.model.repositories.key ?? "",
				result: Result.succeed(rescannedOf(NOW)),
			}),
		)
		expect(finished.model.pendingScans).toEqual([])
		expect(names(finished.commands)).toEqual(["SecurityApiDependencyFindings"])
	})

	test("a pending scan stops polling after two minutes", () => {
		const queued = apply(loaded(), [
			() => Message.ClickedScanNow({ repositoryId: PAYMENTS_ID }),
			() =>
				Message.CompletedScanRequest({
					repositoryId: PAYMENTS_ID,
					result: Result.succeed({ queued: true }),
				}),
		])
		const late = pageUpdate(queued, Message.TickedScanPoll({ nowMs: NOW + 121_000 }))
		expect(late.model.pendingScans).toEqual([])
		expect(names(late.commands)).toEqual([])
	})

	test("a refused scan says why and lets Scan now be pressed again", () => {
		const refused = pageUpdate(
			pageUpdate(loaded(), Message.ClickedScanNow({ repositoryId: PAYMENTS_ID })).model,
			Message.CompletedScanRequest({
				repositoryId: PAYMENTS_ID,
				result: Result.fail(toLoadFailure(new DependencyScanPersistenceError({ message: "down" }))),
			}),
		)
		expect(refused.outMessage).toMatchObject({ type: "error" })
		expect(
			names(pageUpdate(refused.model, Message.ClickedScanNow({ repositoryId: PAYMENTS_ID })).commands),
		).toEqual(["SecurityApiScanRepository"])
	})

	test("a row opens the finding's sheet with the advisory and where the package is locked", () => {
		scene(
			{ update: pageUpdate, view },
			given(opened(loaded())),
			mounted,
			expectView(role("dialog")).toExist(),
			expectView(text(/ignore baseURL/)).toExist(),
			expectView(text("1.8.2")).toExist(),
			expectView(text("pnpm-lock.yaml")).toExist(),
			expectView(role("button", { name: "Accept risk" })).toExist(),
		)
	})

	test("Dismiss needs a reason, then writes the status with it", () => {
		const write = UpdateFinding({
			findingId: FINDING_IDS.axios,
			status: "dismissed",
			reason: "Not reachable",
		})
		scene(
			{ update: pageUpdate, view },
			given(opened(loaded())),
			mounted,
			click(role("button", { name: "Dismiss" })),
			Command.expectNone(),
			expectView(text("Add a reason. It is shown on the finding with your name.")).toExist(),
			type(role("textbox", { name: "Reason" }), "Not reachable"),
			click(role("button", { name: "Dismiss" })),
			Command.expectHas(write),
			// The server refuses a member's write with a 403; it comes back as an error toast.
			Command.resolve(UpdateFinding, Message.CompletedTriage({ result: forbidden })),
			expectOutMessage(
				PageOutMessage.RequestedToast({
					type: "error",
					title: forbiddenFailure.title,
					description: forbiddenFailure.message,
				}),
			),
		)
	})

	test("a dismissed finding is reopened without a reason", () => {
		const dismissed = apply(loaded(), [
			() =>
				Message.GotStatusSelectMessage({
					message: Select.Message.SelectedItem({ index: 1, value: "dismissed" }),
				}),
			() => Message.ClickedFinding({ findingId: FINDING_IDS.lodash }),
		])
		scene(
			{ update: pageUpdate, view },
			given(dismissed),
			mounted,
			expectView(text("Only used by the docs build, never with user input.")).toExist(),
			click(role("button", { name: "Reopen" })),
			Command.expectHas(UpdateFinding({ findingId: FINDING_IDS.lodash, status: "open", reason: "" })),
			Command.resolve(UpdateFinding, Message.CompletedTriage({ result: forbidden })),
		)
	})

	test("a member sees the finding but not the triage actions", () => {
		scene(
			{ update: pageUpdate, view },
			given(opened(loaded(repositoriesOf(NOW), findingsOf(NOW), false))),
			mounted,
			expectView(text("Only org admins can change a finding's status.")).toExist(),
			expectView(role("button", { name: "Dismiss" })).toBeAbsent(),
		)
	})

	test("a saved triage reads the findings again and says what changed", () => {
		const finding = findingsOf(NOW).findings[0]!
		const saving = apply(opened(loaded()), [
			() =>
				Message.GotReasonMessage({ message: Field.Message.ChangedValue({ value: "Not reachable" }) }),
			() => Message.ClickedTriage({ status: "accepted_risk" }),
		])
		const saved = pageUpdate(
			saving,
			Message.CompletedTriage({ result: Result.succeed({ ...finding, status: "accepted_risk" }) }),
		)
		expect(names(saved.commands)).toEqual(["SecurityApiDependencyFindings"])
		expect(saved.outMessage).toMatchObject({ title: "Marked accepted risk" })
		expect(saved.model.reason.value).toBe("")
	})
})
