import { OrgId } from "@maple/domain"
import { formatRelativeTimeOrDate } from "@maple/ui/lib/time-format"
import { DependencyScanForbiddenError, DependencyScanPersistenceError } from "@maple/domain/http"
import { VcsRepositoryId } from "@maple/domain/http"
import type { DependencyFindingsResponse, DependencyScanRepositoriesResponse } from "@maple/domain/http"
import { DependencyFindingId } from "@maple/domain/dependency-scan"
import { Result, Schema, Array as Arr, String as Str } from "effect"
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
	within,
	withViewInputs,
	Mount,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { toLoadFailure } from "@maple/views/data/load-failure"
import {
	FINDING_IDS,
	findingsOf,
	largeOrgOf,
	neverScannedOf,
	noFindings,
	noRepositories,
	PAYMENTS_ID,
	REPOSITORY_IDS,
	repositoriesOf,
	rescannedOf,
} from "../../../lab/security-dependencies-fixture"
import { AppRoute, hrefOf } from "../../../route"
import type { SecurityDependenciesSearch } from "../../../route/search"
import * as Animation from "@foldkit/ui/animation"
import * as Combobox from "@maple/views/ui/combobox"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"
import * as Select from "@maple/views/ui/select"
import { type PageContext, PageOutMessage } from "../../contract"
import { UpdateFinding } from "./command"
import { reasonErrorOf } from "./derive"
import { Message, type Model } from "./model"
import { init, routeChanged, update } from "./update"
import { view as pageView } from "./view"

const context: PageContext = {
	orgId: Schema.decodeSync(OrgId)("org_acme"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const NOW = Date.UTC(2026, 10, 1, 9, 0)
const route = AppRoute.SecurityDependencies({ search: {} })
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)
const apply = (model: Model, messages: ReadonlyArray<(model: Model) => Message>): Model =>
	Arr.reduce(messages, model, (current, toMessage) => pageUpdate(current, toMessage(current)).model)

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

/** The same answers at another URL: a repository, the advisories table, or both. */
const at = (model: Model, search: SecurityDependenciesSearch): Model =>
	routeChanged(model, AppRoute.SecurityDependencies({ search }), context).model
const ADVISORIES: SecurityDependenciesSearch = { view: "advisories" }

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

	test("before any scan, the URL's tab still decides the view", () => {
		scene(
			{ update: pageUpdate, view },
			given(at(loaded(neverScannedOf(NOW), noFindings), ADVISORIES)),
			expectView(text("First scan is on its way")).toExist(),
			expectView(role("link", { name: /^Advisories/ })).toHaveAttr("aria-current", "page"),
			expectView(role("table", { name: "Repositories" })).toBeAbsent(),
		)
	})

	test("names the busiest service running each finding, and says when one is not deployed", () => {
		scene(
			{ update: pageUpdate, view },
			given(at(loaded(repositoriesOf(NOW), findingsOf(NOW)), ADVISORIES)),
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
				at(
					loaded(
						{
							repositories: Arr.map(repositories.repositories, (repository) =>
								repository.id === PAYMENTS_ID
									? {
											...repository,
											runningCommits: Arr.map(repository.runningCommits, (commit) => ({
												...commit,
												scanStatus: null,
											})),
										}
									: repository,
							),
						},
						{
							...findingsOf(NOW),
							findings: Arr.map(findingsOf(NOW).findings, (finding) => ({
								...finding,
								production: [],
							})),
						},
					),
					ADVISORIES,
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
				at(
					loaded(
						{
							repositories: Arr.map(repositories.repositories, (repository) =>
								repository.id === PAYMENTS_ID
									? {
											...repository,
											runningCommits: Arr.map(repository.runningCommits, (commit) => ({
												...commit,
												scanStatus: "running" as const,
											})),
										}
									: repository,
							),
						},
						{
							...findingsOf(NOW),
							findings: Arr.map(findingsOf(NOW).findings, (finding) => ({
								...finding,
								production: [],
							})),
						},
					),
					ADVISORIES,
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
				at(
					loaded(
						{
							repositories: Arr.map(repositories.repositories, (repository) =>
								repository.id === PAYMENTS_ID
									? {
											...repository,
											runningCommits: Arr.map(repository.runningCommits, (commit) => ({
												...commit,
												scanStatus: "failed" as const,
											})),
										}
									: repository,
							),
						},
						{
							...findingsOf(NOW),
							findings: Arr.map(findingsOf(NOW).findings, (finding) => ({
								...finding,
								production: [],
							})),
						},
					),
					ADVISORIES,
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
						repositories: Arr.map(repositories.repositories, (repository) =>
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
						repositories: Arr.map(repositories.repositories, (repository) =>
							repository.latestScan === null
								? repository
								: {
										...repository,
										latestScan: {
											...repository.latestScan,
											status: "completed" as const,
											lockfiles: Arr.map(
												repository.latestScan.lockfiles,
												(lockfile) => ({
													...lockfile,
													status: "too_large" as const,
												}),
											),
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
						repositories: Arr.map(repositories.repositories, (repository) =>
							repository.latestScan === null
								? repository
								: {
										...repository,
										latestScan: {
											...repository.latestScan,
											status: "completed" as const,
											error: "612 known vulnerabilities past the 500 a scan reads were left out",
											lockfiles: Arr.map(
												repository.latestScan.lockfiles,
												(lockfile) => ({
													...lockfile,
													status: "parsed" as const,
												}),
											),
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
				at(
					loaded(repositoriesOf(NOW), {
						...findingsOf(NOW),
						production: { ...findingsOf(NOW).production, complete: false },
					}),
					ADVISORIES,
				),
			),
			expectView(text("Not running")).toBeAbsent(),
			expectView(text("Unknown")).toExist(),
		)
	})

	test("caps a triage reason as the API does, untrimmed", () => {
		expect(reasonErrorOf(Str.repeat(10)(" ") + Str.repeat(495)("x"))).not.toBeNull()
		expect(reasonErrorOf(Str.repeat(500)("x"))).toBeNull()
		expect(reasonErrorOf("   ")).not.toBeNull()
	})

	test("explains why findings cannot be tied to production when no service reports its commit", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				at(
					loaded(repositoriesOf(NOW), {
						...findingsOf(NOW),
						findings: Arr.map(findingsOf(NOW).findings, (finding) => ({
							...finding,
							production: [],
						})),
						production: {
							available: true,
							runningServices: 0,
							linkedServices: 0,
							complete: true,
						},
					}),
					ADVISORIES,
				),
			),
			expectView(text(/vcs\.ref\.head\.revision/)).toExist(),
			expectView(text("Unknown")).toExist(),
			expectView(text("api-gateway +1")).toBeAbsent(),
		)
	})

	test("scanned with nothing open shows the calm clean state", () => {
		// Clean needs every lockfile read; the fixture's unsupported and failed ones are not.
		const allParsed = {
			repositories: Arr.map(repositoriesOf(NOW).repositories, (repository) =>
				repository.latestScan === null
					? repository
					: {
							...repository,
							latestScan: {
								...repository.latestScan,
								lockfiles: Arr.map(repository.latestScan.lockfiles, (lockfile) => ({
									...lockfile,
									status: "parsed" as const,
								})),
							},
						},
			),
		}
		const settled = Arr.filter(findingsOf(NOW).findings, (finding) => finding.status !== "open")
		scene(
			{ update: pageUpdate, view },
			given(loaded(allParsed, { ...findingsOf(NOW), findings: settled })),
			expectView(text("No known vulnerable packages")).toExist(),
			expectView(text("axios")).toBeAbsent(),
		)
	})

	test("every repository reads as a matrix: a package per row, a dot where it is open, worst first", () => {
		const matrix = role("table", { name: "Vulnerable packages by repository" })
		scene(
			{ update: pageUpdate, view },
			given(loaded()),
			// Both axios advisories are one dot, linked to the repository's upgrade plan.
			expectView(
				within(
					matrix,
					role("link", { name: /^axios in acme\/payments-api, Critical, 2 advisories/ }),
				),
			).toHaveAttr("href", hrefOf(AppRoute.SecurityDependencies({ search: { repo: PAYMENTS_ID } }))),
			expectView(within(matrix, role("link", { name: "acme/web" }))).toHaveAttr(
				"href",
				hrefOf(AppRoute.SecurityDependencies({ search: { repo: REPOSITORY_IDS.web } })),
			),
			// The fix column is the highest version any lockfile needs.
			expectView(within(matrix, text("1.12.0"))).toExist(),
			expectView(within(matrix, text("No fix yet"))).toExist(),
			expectView(within(matrix, text("lodash.template"))).toBeAbsent(),
			expectView(within(matrix, text("jsonwebtoken"))).toBeAbsent(),
			expectView(text(/3 \/ 3 scanned/)).toExist(),
			expectView(text("+1 unrated")).toExist(),
		)
	})

	test("every repository says how many scans could not read everything, and the Repositories tab says why", () => {
		scene(
			{ update: pageUpdate, view },
			given(loaded()),
			expectView(text("2 repositories could not be read in full.")).toExist(),
			expectView(role("link", { name: "See which" })).toHaveAttr(
				"href",
				hrefOf(AppRoute.SecurityDependencies({ search: { view: "repositories" } })),
			),
		)
		const repositories = role("table", { name: "Repositories" })
		scene(
			{ update: pageUpdate, view },
			given(at(loaded(), { view: "repositories" })),
			expectView(within(repositories, text("Line 212: expected a [[package]] table."))).toExist(),
			expectView(within(repositories, role("link", { name: "acme/payments-api" }))).toHaveAttr(
				"href",
				hrefOf(AppRoute.SecurityDependencies({ search: { repo: PAYMENTS_ID } })),
			),
			// Two axios advisories are one bump.
			expectView(within(repositories, text("3 upgrades clear 4"))).toExist(),
		)
	})
	test("a repository's pane names its lockfile problems", () => {
		scene(
			{ update: pageUpdate, view },
			given(at(loaded(), { repo: PAYMENTS_ID })),
			expectView(text("Line 212: expected a [[package]] table.")).toExist(),
		)
	})

	test("the advisories tab lists open findings worst first, linked to OSV", () => {
		scene(
			{ update: pageUpdate, view },
			given(at(loaded(), ADVISORIES)),
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
			given(apply(at(loaded(), ADVISORIES), [status("dismissed")])),
			expectView(text("lodash.template")).toExist(),
			expectView(text("axios")).toBeAbsent(),
		)
		scene(
			{ update: pageUpdate, view },
			given(apply(at(loaded(), ADVISORIES), [status("all")])),
			expectView(text("lodash.template")).toExist(),
			expectView(text("jsonwebtoken")).toExist(),
			expectView(text("axios")).toExist(),
		)
	})

	test("picking a repository in the switcher opens it", () => {
		const step = pageUpdate(
			loaded(),
			Message.GotRepositoryBoxMessage({
				message: Combobox.Message.ClickedItem({ value: "acme/payments-api" }),
			}),
		)
		expect(step.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: hrefOf(AppRoute.SecurityDependencies({ search: { repo: PAYMENTS_ID } })),
				isReplace: false,
			}),
		)
	})
	test("the switcher keeps the advisories tab, and leaves the repositories tab for the upgrade plan", () => {
		const pick = (model: Model) =>
			pageUpdate(
				model,
				Message.GotRepositoryBoxMessage({
					message: Combobox.Message.ClickedItem({ value: "acme/payments-api" }),
				}),
			).outMessage
		expect(pick(at(loaded(), ADVISORIES))).toEqual(
			PageOutMessage.RequestedNavigation({
				url: hrefOf(
					AppRoute.SecurityDependencies({ search: { repo: PAYMENTS_ID, view: "advisories" } }),
				),
				isReplace: false,
			}),
		)
		expect(pick(at(loaded(), { view: "repositories" }))).toEqual(
			PageOutMessage.RequestedNavigation({
				url: hrefOf(AppRoute.SecurityDependencies({ search: { repo: PAYMENTS_ID } })),
				isReplace: false,
			}),
		)
	})

	test("the matrix gives the riskiest repositories a column and counts every one", () => {
		// Eight more repositories, each with the critical axios advisory.
		const repositoryId = (index: number) =>
			Schema.decodeSync(VcsRepositoryId)(`00000000-0000-4000-8000-00000000000${index}`)
		const extra = Arr.flatMap(repositoriesOf(NOW).repositories.slice(0, 1), (base) =>
			Array.from({ length: 8 }, (_, index) => ({
				...base,
				id: repositoryId(index),
				fullName: `acme/extra-${index}`,
			})),
		)
		const findings = findingsOf(NOW)
		const extraFindings = Arr.filter(
			findings.findings,
			(finding) => finding.id === FINDING_IDS.axios,
		).flatMap((axios) =>
			extra.map((repository, index) => ({
				...axios,
				id: Schema.decodeSync(DependencyFindingId)(`${Str.repeat(31)("e")}${index}`),
				repositoryId: repository.id,
				repositoryFullName: repository.fullName,
			})),
		)
		const model = loaded(
			{ repositories: [...repositoriesOf(NOW).repositories, ...extra] },
			{ ...findings, findings: [...findings.findings, ...extraFindings] },
		)
		const matrix = role("table", { name: "Vulnerable packages by repository" })
		scene(
			{ update: pageUpdate, view },
			given(model),
			// 11 affected repositories: 5 columns, and axios counted in all 9 that have it.
			expectView(within(matrix, role("columnheader", { name: "Repos" }))).toExist(),
			expectView(within(matrix, text("9"))).toExist(),
			expectView(within(matrix, role("link", { name: "acme/cli" }))).toBeAbsent(),
			expectView(within(matrix, role("link", { name: "acme/extra-7" }))).toBeAbsent(),
		)
		scene(
			{ update: pageUpdate, view },
			given(model),
			click(within(matrix, role("button", { name: /axios/ }))),
			// Opened, the row names every repository it is open in, counted ones included.
			expectView(within(matrix, role("link", { name: "acme/extra-7" }))).toHaveAttr(
				"href",
				hrefOf(
					AppRoute.SecurityDependencies({
						search: { repo: repositoryId(7) },
					}),
				),
			),
			expectView(within(matrix, text("1.7.4 → 1.12.0"))).toExist(),
		)
	})
	test("a focused repository shows its upgrade plan and only its findings", () => {
		const routed = routeChanged(
			loaded(),
			AppRoute.SecurityDependencies({ search: { repo: PAYMENTS_ID } }),
			context,
		).model
		const plan = role("table", { name: "Upgrade plan for acme/payments-api" })
		scene(
			{ update: pageUpdate, view },
			given(routed),
			expectView(text("3 upgrades clear 4 of 4 open advisories.")).toExist(),
			// The bump goes to the higher of the two fixed versions and clears both.
			expectView(within(plan, text("1.12.0"))).toExist(),
			expectView(within(plan, text("1.8.2"))).toBeAbsent(),
			expectView(within(plan, text("2 advisories"))).toExist(),
			expectView(role("link", { name: /Upgrade plan/ })).toHaveAttr("aria-current", "page"),
			expectView(text("tokio")).toBeAbsent(),
		)
	})

	test("the plan bumps to the highest fix any lockfile needs for one advisory", () => {
		const findings = findingsOf(NOW)
		// The critical axios advisory again, in a lockfile whose line is fixed later.
		const copies = Arr.flatMap(findings.findings, (finding) =>
			finding.id === FINDING_IDS.axios
				? [
						{
							...finding,
							id: FINDING_IDS.jwt,
							lockfilePath: "apps/admin/pnpm-lock.yaml",
							fixedIn: "1.13.0",
						},
					]
				: [],
		)
		const routed = routeChanged(
			loaded(repositoriesOf(NOW), { ...findings, findings: [...copies, ...findings.findings] }),
			AppRoute.SecurityDependencies({ search: { repo: PAYMENTS_ID } }),
			context,
		).model
		const plan = role("table", { name: "Upgrade plan for acme/payments-api" })
		scene(
			{ update: pageUpdate, view },
			given(routed),
			expectView(within(plan, text("1.13.0"))).toExist(),
			expectView(within(plan, text("2 advisories"))).toExist(),
		)
	})

	test("the plan counts an advisory once however many lockfiles carry it", () => {
		const findings = findingsOf(NOW)
		// The critical axios advisory again, locked in a second lockfile.
		const copies = Arr.flatMap(findings.findings, (finding) =>
			finding.id === FINDING_IDS.axios
				? [{ ...finding, id: FINDING_IDS.jwt, lockfilePath: "apps/admin/pnpm-lock.yaml" }]
				: [],
		)
		const routed = routeChanged(
			loaded(repositoriesOf(NOW), { ...findings, findings: [...copies, ...findings.findings] }),
			AppRoute.SecurityDependencies({ search: { repo: PAYMENTS_ID } }),
			context,
		).model
		const plan = role("table", { name: "Upgrade plan for acme/payments-api" })
		scene(
			{ update: pageUpdate, view },
			given(routed),
			expectView(within(plan, text("2 advisories"))).toExist(),
			expectView(within(plan, text("+1 lockfile"))).toExist(),
		)
	})

	test("the plan says Unknown, not Not running, when production could not be read", () => {
		const findings = findingsOf(NOW)
		const routed = routeChanged(
			loaded(repositoriesOf(NOW), {
				...findings,
				production: { ...findings.production, available: false },
			}),
			AppRoute.SecurityDependencies({ search: { repo: PAYMENTS_ID } }),
			context,
		).model
		const plan = role("table", { name: "Upgrade plan for acme/payments-api" })
		scene(
			{ update: pageUpdate, view },
			given(routed),
			expectView(within(plan, text("Unknown"))).toExist(),
			expectView(within(plan, text("Not running"))).toBeAbsent(),
		)
	})

	test("a repository with nothing to bump to says no fix exists yet", () => {
		const routed = routeChanged(
			loaded(),
			AppRoute.SecurityDependencies({ search: { repo: REPOSITORY_IDS.web } }),
			context,
		).model
		scene(
			{ update: pageUpdate, view },
			given(routed),
			expectView(text("None of 1 open advisory has a fixed version yet.")).toExist(),
		)
	})

	test("at 300 repositories an opened package lists a page of them, then every one", () => {
		const org = largeOrgOf(NOW, 300)
		const matrix = role("table", { name: "Vulnerable packages by repository" })
		const opened = pageUpdate(
			loaded(org.repositories, org.findings),
			Message.ClickedPackage({ key: "npm/axios" }),
		).model
		scene(
			{ update: pageUpdate, view },
			given(opened),
			expectView(within(matrix, role("button", { name: /^Show all \d+ repositories$/ }))).toExist(),
		)
		const all = pageUpdate(opened, Message.ClickedShowAllRepositories({ key: "npm/axios" })).model
		scene(
			{ update: pageUpdate, view },
			given(all),
			expectView(within(matrix, role("button", { name: /^Show all/ }))).toBeAbsent(),
		)
	})

	test("at 300 repositories the tables render a page at a time", () => {
		const org = largeOrgOf(NOW, 300)
		const model = at(loaded(org.repositories, org.findings), { view: "repositories" })
		scene(
			{ update: pageUpdate, view },
			given(model),
			expectView(text("Showing 100 of 300 repositories")).toExist(),
			click(role("button", { name: "Load more" })),
			expectView(text("Showing 200 of 300 repositories")).toExist(),
		)
	})

	test("an empty upgrade plan does not call an unread repository clean", () => {
		const focused = (repositories: DependencyScanRepositoriesResponse) =>
			at(loaded(repositories, noFindings), { repo: PAYMENTS_ID })
		scene(
			{ update: pageUpdate, view },
			given(focused(neverScannedOf(NOW))),
			expectView(text("Not scanned yet, so there is nothing to plan.")).toExist(),
			expectView(text("No open advisories in this repository's latest scan")).toBeAbsent(),
		)
		// The fixture's payments scan could not read one lockfile.
		scene(
			{ update: pageUpdate, view },
			given(focused(repositoriesOf(NOW))),
			expectView(text("No open advisories in what the latest scan could read.")).toExist(),
		)
	})

	test("the switcher reads the focused repository, even before any scan", () => {
		const routed = routeChanged(
			loaded(neverScannedOf(NOW), noFindings),
			AppRoute.SecurityDependencies({ search: { repo: PAYMENTS_ID } }),
			context,
		).model
		scene(
			{ update: pageUpdate, view },
			given(routed),
			expectView(role("combobox", { name: "Repository" })).toHaveAttr("value", "acme/payments-api"),
		)
	})
	test("re-picking the focused repository does not navigate again", () => {
		const focused = routeChanged(
			loaded(),
			AppRoute.SecurityDependencies({ search: { repo: PAYMENTS_ID } }),
			context,
		).model
		const step = pageUpdate(
			focused,
			Message.GotRepositoryBoxMessage({
				message: Combobox.Message.ClickedItem({ value: "acme/payments-api" }),
			}),
		)
		expect(step.outMessage).toBeUndefined()
	})

	test("a repo in the URL that is not connected shows every repository and leaves the URL", () => {
		const entered = init(AppRoute.SecurityDependencies({ search: { repo: "gone" } }), context).model
		const answered = pageUpdate(
			entered,
			Message.CompletedFetchRepositories({
				key: entered.repositories.key ?? "",
				result: Result.succeed(repositoriesOf(NOW)),
			}),
		)
		expect(answered.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: hrefOf(AppRoute.SecurityDependencies({ search: {} })),
				isReplace: true,
			}),
		)
		const navigated = routeChanged(
			loaded(),
			AppRoute.SecurityDependencies({ search: { repo: "gone" } }),
			context,
		)
		expect(navigated.outMessage).toEqual(
			PageOutMessage.RequestedNavigation({
				url: hrefOf(AppRoute.SecurityDependencies({ search: {} })),
				isReplace: true,
			}),
		)
		const routed = navigated.model
		scene(
			{ update: pageUpdate, view },
			given(routed),
			expectView(text("Upgrade plan")).toBeAbsent(),
			expectView(text("tokio")).toExist(),
			expectView(text("axios")).toExist(),
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
			given(at(queued.model, { repo: PAYMENTS_ID })),
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

	test("an upgrade opens to the advisories it clears, and each opens its finding", () => {
		const plan = role("table", { name: "Upgrade plan for acme/payments-api" })
		scene(
			{ update: pageUpdate, view },
			given(at(loaded(), { repo: PAYMENTS_ID })),
			click(within(plan, role("button", { name: /^axios/ }))),
			expectView(within(plan, role("button", { name: /CVE-2025-58754/ }))).toExist(),
			click(within(plan, role("button", { name: /CVE-2025-27152/ }))),
			Command.resolve(
				Animation.WaitForPaint,
				Animation.Message.CompletedWaitForPaint({ generation: 1 }),
			),
			Command.resolve(
				Animation.WaitForAnimationSettled,
				Animation.Message.EndedAnimation({ generation: 1 }),
			),
			mounted,
			expectView(role("dialog")).toExist(),
			expectView(text(/ignore baseURL/)).toExist(),
		)
	})

	test("one repository's advisories name the lockfile, not the repository on every row", () => {
		const table = role("table", { name: "Vulnerable packages" })
		scene(
			{ update: pageUpdate, view },
			given(at(loaded(), { repo: PAYMENTS_ID, view: "advisories" })),
			expectView(within(table, role("columnheader", { name: "Lockfile" }))).toExist(),
			expectView(within(table, text("payments-api"))).toBeAbsent(),
		)
		scene(
			{ update: pageUpdate, view },
			given(at(loaded(), ADVISORIES)),
			expectView(within(table, role("columnheader", { name: "Location" }))).toExist(),
		)
	})

	test("the sheet does not date Last seen by the finding's last triage", () => {
		const triagedAt = NOW - 3 * 60 * 1000
		const findings = findingsOf(NOW)
		scene(
			{ update: pageUpdate, view },
			given(
				opened(
					loaded(repositoriesOf(NOW), {
						...findings,
						findings: Arr.map(findings.findings, (finding) =>
							finding.id === FINDING_IDS.axios ? { ...finding, updatedAt: triagedAt } : finding,
						),
					}),
				),
			),
			mounted,
			expectView(text("Last seen")).toExist(),
			expectView(text(formatRelativeTimeOrDate(triagedAt, NOW, "UTC"))).toBeAbsent(),
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

	test("a reason at the cap with a trailing space is written without a length error", () => {
		const reason = Str.repeat(500)("x")
		scene(
			{ update: pageUpdate, view },
			given(opened(loaded())),
			mounted,
			type(role("textbox", { name: "Reason" }), `${reason} `),
			click(role("button", { name: "Dismiss" })),
			Command.expectHas(UpdateFinding({ findingId: FINDING_IDS.axios, status: "dismissed", reason })),
			expectView(text(/Keep the reason under/)).toBeAbsent(),
			Command.resolve(UpdateFinding, Message.CompletedTriage({ result: forbidden })),
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
