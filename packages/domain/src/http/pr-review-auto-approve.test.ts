/**
 * `prReviewAutoApproval`: when a review may approve a pull request without a person reading it.
 * Every condition has to hold, so each case below breaks exactly one of them on an otherwise
 * approvable report.
 */
import { assert, describe, it } from "vitest"
import {
	PrReviewCoverageUnit,
	PrReviewFinding,
	PrReviewMergeStep,
	PrReviewReport,
	PrReviewRepositoryConfig,
} from "./pr-review"
import {
	PR_CHANGED_FILES_MAX_LISTED,
	PR_FILE_DIFF_MAX_LINES,
	PR_REVIEW_AUTO_APPROVE_MAX_CHANGED_LINES,
	PR_REVIEW_AUTO_APPROVE_MAX_FILES,
	isSensitivePath,
	prReviewDiffMayApprove,
	prReviewDiffSignals,
} from "./pr-review-diff"
import {
	mergePrReviewConfig,
	prReviewAutoApproval,
	prReviewConfigNeedsAutoApprove,
	prReviewDefaultsNeedAutoApprove,
} from "./pr-review-rules"
import * as Policy from "../policy"
import type { PullRequestFile } from "./vcs"
import { Array as Arr, Record as Rec, String as Str } from "effect"
import { PrReviewContractBreak, PrReviewTelemetry } from "./pr-review-telemetry"

const finding = (
	severity: "critical" | "warn" | "info",
	category: "correctness" | "security" = "correctness",
) => new PrReviewFinding({ path: "a.ts", line: 1, category, severity, title: "t", body: "b" })

const approvable = (overrides: Partial<ConstructorParameters<typeof PrReviewReport>[0]> = {}) =>
	new PrReviewReport({
		verdict: "clean",
		summary: "Renames a label.",
		risk: "low",
		tests: "not_needed",
		wholeDiff: true,
		coverage: [],
		findings: [],
		...overrides,
	})

const unrated = () => {
	const { risk: _risk, ...rest } = approvable()
	return new PrReviewReport(rest)
}

const untested = () => {
	const { tests: _tests, ...rest } = approvable()
	return new PrReviewReport(rest)
}

const telemetryWithBreak = new PrReviewTelemetry({
	windowDays: 7,
	services: [],
	contractBreaks: [
		new PrReviewContractBreak({
			kind: "attribute",
			name: "http.route",
			path: "a.ts",
			line: 3,
			references: [],
		}),
	],
	hotFiles: [],
	linkedIssues: [],
	costNotes: [],
	added: [],
	removed: [],
})

/** A decision over a submission the model sent clean and whole; each case overrides what it breaks. */
const decide = (input: Parameters<typeof prReviewAutoApproval>[0]) =>
	prReviewAutoApproval({
		submitted: { verdict: "clean", droppedFindings: 0 },
		diff: signals([file("src/orders/label.ts")]),
		...input,
	})

const file = (path: string, overrides: Partial<PullRequestFile> = {}): PullRequestFile => ({
	path,
	previousPath: null,
	status: "modified",
	additions: 2,
	deletions: 1,
	patch: "@@ -1,2 +1,2 @@\n-a\n+b\n c",
	...overrides,
})

const signals = (files: ReadonlyArray<PullRequestFile>, truncated = false) =>
	prReviewDiffSignals({ files, truncated, isIgnored: () => false })

const LONG_PATCH = Arr.join(
	["@@ -1,1 +1,2000 @@", ...Arr.makeBy(PR_FILE_DIFF_MAX_LINES + 10, (i) => `+line ${i}`)],
	"\n",
)

describe("prReviewAutoApproval", () => {
	it("approves a clean, low-risk, fully read change", () => {
		const decision = decide({ report: approvable() })
		assert.isTrue(decision.approve)
		assert.include(decision.reason, "confidence 10/10")
	})

	it("approves beside notes: an info finding is not something to fix", () => {
		assert.isTrue(decide({ report: approvable({ findings: [finding("info")] }) }).approve)
	})

	it("approves at 9: new work without a span costs a point, not the approval", () => {
		const report = approvable({
			coverage: [
				new PrReviewCoverageUnit({
					unit: "cron",
					kind: "background",
					instrumented: false,
					evidence: "no span",
				}),
			],
		})
		const decision = decide({ report })
		assert.isTrue(decision.approve)
		assert.include(decision.reason, "confidence 9/10")
	})

	it("approves covered tests and a step before merge someone else ticked", () => {
		const report = approvable({
			tests: "covered",
			beforeMerge: [
				new PrReviewMergeStep({
					kind: "env",
					title: "Set FOO",
					source: "diff",
					done: true,
					doneBy: "maintainer",
				}),
			],
		})
		assert.isTrue(decide({ report, authorLogin: "octocat" }).approve)
	})

	it("approves a small diff of reviewed files and prose", () => {
		const diff = prReviewDiffSignals({
			files: [file("src/label.ts"), file("docs/labels.md"), file("README.md")],
			truncated: false,
			isIgnored: () => false,
		})
		assert.isTrue(decide({ report: approvable(), diff }).approve)
	})

	const refusals: ReadonlyArray<readonly [string, Parameters<typeof prReviewAutoApproval>[0], string]> = [
		["an early end", { report: approvable(), partial: true }, "partial"],
		[
			"a pass over only the latest commits",
			{ report: approvable({ wholeDiff: false }) },
			"not_whole_diff",
		],
		["a diff Maple could not read", { report: approvable(), diffUnavailable: true }, "diff_unavailable"],
		["a file with no patch", { report: approvable(), patchlessFiles: 1 }, "patchless"],
		["a file under an ignored path", { report: approvable(), ignoredFiles: 1 }, "ignored_files"],
		["a warning someone dismissed", { report: approvable(), dismissedIssues: 1 }, "dismissed"],
		[
			"a warning the repository's lenses held back",
			{ report: approvable(), filteredIssues: 1 },
			"filtered",
		],
		["an unread file", { report: approvable({ unreviewed: ["b.ts"] }) }, "unread"],
		["a fix not re-checked", { report: approvable(), uncheckedFixes: 1 }, "unchecked_fixes"],
		["an issues verdict", { report: approvable({ verdict: "issues" }) }, "verdict"],
		["a not-applicable verdict", { report: approvable({ verdict: "not_applicable" }) }, "verdict"],
		["a warning", { report: approvable({ findings: [finding("warn")] }) }, "findings"],
		["a critical", { report: approvable({ findings: [finding("critical", "security")] }) }, "findings"],
		[
			"a warning open from an earlier push",
			{ report: approvable(), carriedOpen: [finding("warn")] },
			"findings",
		],
		["medium risk", { report: approvable({ risk: "medium" }) }, "risk"],
		["high risk", { report: approvable({ risk: "high" }) }, "risk"],
		["an unrated risk", { report: unrated() }, "risk"],
		["missing tests", { report: approvable({ tests: "missing" }) }, "tests"],
		["partial tests", { report: approvable({ tests: "partial" }) }, "tests"],
		["tests not assessed", { report: untested() }, "tests"],
		[
			"an open step before merge",
			{
				report: approvable({
					beforeMerge: [
						new PrReviewMergeStep({ kind: "migration", title: "Run it", source: "diff" }),
					],
				}),
			},
			"merge_steps",
		],
		[
			"a step before merge its author ticked",
			{
				report: approvable({
					beforeMerge: [
						new PrReviewMergeStep({
							kind: "migration",
							title: "Run it",
							source: "diff",
							done: true,
							doneBy: "OctoCat",
						}),
					],
				}),
				authorLogin: "octocat",
			},
			"author_ticked_steps",
		],
		[
			"a ticked step when the author is not known",
			{
				report: approvable({
					beforeMerge: [
						new PrReviewMergeStep({
							kind: "migration",
							title: "Run it",
							source: "diff",
							done: true,
							doneBy: "maintainer",
						}),
					],
				}),
			},
			"author_ticked_steps",
		],
		[
			"a verdict the reviewer never sent",
			{ report: approvable(), submitted: { verdict: undefined, droppedFindings: 0 } },
			"submitted_verdict",
		],
		[
			"an issues verdict whose findings were all dropped",
			{ report: approvable(), submitted: { verdict: "issues", droppedFindings: 0 } },
			"submitted_verdict",
		],
		[
			"a finding dropped as unreadable",
			{ report: approvable(), submitted: { verdict: "clean", droppedFindings: 1 } },
			"dropped_findings",
		],
		[
			"a generated file nobody read",
			{ report: approvable(), diff: signals([file("src/routeTree.gen.ts")]) },
			"unreviewed_kinds",
		],
		[
			"a tooling script nobody read",
			{ report: approvable(), diff: signals([file("tools/release.ts")]) },
			"unreviewed_kinds",
		],
		[
			"a file under docs that is not prose",
			{ report: approvable(), diff: signals([file("docs/site/theme.ts")]) },
			"unreviewed_kinds",
		],
		[
			"a patch longer than the reviewer was shown",
			{ report: approvable(), diff: signals([file("src/big.ts", { patch: LONG_PATCH })]) },
			"truncated_patch",
		],
		[
			"a listing the provider cut short",
			{ report: approvable(), diff: signals([file("src/a.ts")], true) },
			"truncated_listing",
		],
		[
			"more files than the reviewer was listed",
			{
				report: approvable(),
				diff: signals(
					Arr.makeBy(PR_CHANGED_FILES_MAX_LISTED + 1, (i) =>
						file(`src/f${i}.ts`, { additions: 0 }),
					),
				),
			},
			"truncated_listing",
		],
		[
			"a workflow change rated low risk",
			{ report: approvable(), diff: signals([file(".github/workflows/ci.yml")]) },
			"sensitive_paths",
		],
		[
			"more changed lines than the cap",
			{
				report: approvable(),
				diff: signals([
					file("src/a.ts", { additions: PR_REVIEW_AUTO_APPROVE_MAX_CHANGED_LINES, deletions: 1 }),
				]),
			},
			"too_large",
		],
		[
			"more changed files than the cap",
			{
				report: approvable(),
				diff: signals(Arr.makeBy(PR_REVIEW_AUTO_APPROVE_MAX_FILES + 1, (i) => file(`src/f${i}.ts`))),
			},
			"too_large",
		],
		[
			"a warning its author settled by reply",
			{ report: approvable(), untrustedSettlements: 1 },
			"untrusted_settlement",
		],
		[
			"an open telemetry contract break",
			{
				report: approvable({ telemetry: telemetryWithBreak }),
			},
			"contract_break",
		],
	]

	for (const [what, input, refusal] of refusals) {
		it(`refuses ${what}`, () => {
			const decision = decide(input)
			assert.isFalse(decision.approve)
			if (!decision.approve) assert.equal(decision.refusal, refusal)
		})
	}

	it("names an unscored review's verdict once, not again as a missing score", () => {
		const decision = decide({ report: approvable({ verdict: "not_applicable" }) })
		assert.isFalse(decision.approve)
		if (!decision.approve) assert.deepEqual(decision.reasons, ["the verdict is not_applicable"])
	})

	it("refuses a submission it was told nothing about", () => {
		const decision = prReviewAutoApproval({
			report: approvable(),
			diff: signals([file("src/orders/label.ts")]),
		})
		assert.isFalse(decision.approve)
		if (!decision.approve) assert.equal(decision.refusal, "submitted_verdict")
	})

	it("refuses when Maple's own read of the diff is missing", () => {
		const decision = prReviewAutoApproval({
			report: approvable(),
			submitted: { verdict: "clean", droppedFindings: 0 },
		})
		assert.isFalse(decision.approve)
		if (!decision.approve) assert.equal(decision.refusal, "diff_unavailable")
	})

	it("names up to three sensitive paths and counts the rest", () => {
		const decision = decide({
			report: approvable(),
			diff: signals([
				file(".github/workflows/ci.yml"),
				file("package.json"),
				file("src/auth/session.ts"),
				file("bun.lock"),
				file("CODEOWNERS"),
			]),
		})
		assert.isFalse(decision.approve)
		if (!decision.approve) {
			assert.include(
				decision.reasons,
				"the diff touches .github/workflows/ci.yml, package.json, src/auth/session.ts and 2 more sensitive paths",
			)
		}
	})

	it("names every unmet condition, not only the first", () => {
		const step = (title: string) => new PrReviewMergeStep({ kind: "infra", title, source: "diff" })
		const decision = decide({
			report: approvable({
				wholeDiff: false,
				risk: "high",
				tests: "covered",
				beforeMerge: [step("Check staging"), step("Check prod")],
			}),
		})
		assert.isFalse(decision.approve)
		if (!decision.approve) {
			assert.equal(decision.refusal, "not_whole_diff")
			assert.deepEqual(decision.reasons, [
				"the review read only the commits since the last one",
				"the risk is high",
				"2 steps before merge are open",
			])
		}
	})
})

describe("mergePrReviewConfig autoApprove", () => {
	it("takes the repository's choice over the organization's", () => {
		const merged = mergePrReviewConfig(
			new PrReviewRepositoryConfig({ autoApprove: true }),
			new PrReviewRepositoryConfig({ autoApprove: false }),
		)
		assert.isFalse(merged.autoApprove)
	})

	it("inherits the organization's when the repository says nothing", () => {
		const merged = mergePrReviewConfig(
			new PrReviewRepositoryConfig({ autoApprove: true }),
			new PrReviewRepositoryConfig({}),
		)
		assert.isTrue(merged.autoApprove)
	})
})

describe("isSensitivePath", () => {
	it("holds CI, ownership, dependencies, containers, deploys and migrations for a person", () => {
		const sensitive = [
			".github/workflows/deploy.yml",
			".github/dependabot.yml",
			".gitlab-ci.yml",
			".circleci/config.yml",
			"CODEOWNERS",
			"docs/CODEOWNERS",
			".github/CODEOWNERS",
			"bun.lock",
			"apps/api/pnpm-lock.yaml",
			"package.json",
			"apps/web/package.json",
			"services/worker/requirements.txt",
			"go.mod",
			"Dockerfile",
			"docker/api.Dockerfile",
			"compose.yaml",
			"docker-compose.dev.yml",
			"infra/main.tf",
			"apps/api/alchemy.run.ts",
			"apps/api/wrangler.jsonc",
			"packages/db/drizzle/20261111_cost/migration.sql",
			"db/migrations/0004_orders.ts",
			"scripts/backfill.sql",
		]
		assert.deepEqual(
			Arr.filter(sensitive, (path) => !isSensitivePath(path)),
			[],
		)
	})

	it("reads a word that follows an acronym, and the acronym itself", () => {
		assert.deepEqual(
			Arr.filter(
				[
					"src/SSOClient.ts",
					"src/HTTPAuthorization.ts",
					"lib/OAuthTokenStore.kt",
					"src/AuthService.ts",
				],
				(path) => !isSensitivePath(path),
			),
			[],
		)
		assert.isFalse(isSensitivePath("src/HTTPClient.ts"))
	})

	it("holds paths named for sign-in, access or secrets", () => {
		const sensitive = [
			"src/auth/session.ts",
			"apps/api/src/routes/auth.http.ts",
			"src/services/AuthService.ts",
			"src/lib/oauth-callback.ts",
			"packages/infra/src/secrets.ts",
			"src/aws/credentials.ts",
			"packages/domain/src/policy/permissions.ts",
			"src/installation-tokens.ts",
			".env",
			".env.production",
			"apps/web/.env.local",
			"certs/server.pem",
		]
		assert.deepEqual(
			Arr.filter(sensitive, (path) => !isSensitivePath(path)),
			[],
		)
	})

	it("holds the files the reviewer takes its instructions from", () => {
		const sensitive = ["CLAUDE.md", "AGENTS.md", "apps/web/CLAUDE.md", ".maple/review.md"]
		assert.deepEqual(
			Arr.filter(sensitive, (path) => !isSensitivePath(path)),
			[],
		)
	})

	it("leaves ordinary source, tests and prose alone", () => {
		const ordinary = [
			"src/orders/list.ts",
			"apps/web/src/page/dashboard/view.ts",
			"src/authors/profile.ts",
			"src/orders/list.test.ts",
			"README.md",
			"docs/api-v2.md",
			"tsconfig.json",
		]
		assert.deepEqual(Arr.filter(ordinary, isSensitivePath), [])
	})
})

describe("prReviewDiffSignals", () => {
	it("counts a renamed file's old path as touched", () => {
		const diff = signals([
			file("ci/old-deploy.yml", { status: "renamed", previousPath: ".github/workflows/deploy.yml" }),
		])
		assert.deepEqual(diff.sensitivePaths, [".github/workflows/deploy.yml"])
	})

	it("leaves ignored files to their own refusal", () => {
		const diff = prReviewDiffSignals({
			files: [file("vendor/lib.gen.ts", { patch: LONG_PATCH }), file("src/a.ts")],
			truncated: false,
			isIgnored: Str.startsWith("vendor/"),
		})
		assert.equal(diff.unreviewedKindFiles, 0)
		assert.equal(diff.truncatedPatchFiles, 0)
		assert.equal(diff.changedFiles, 2)
	})

	it("counts lines only in the kinds a review reads", () => {
		const diff = signals([
			file("src/a.ts", { additions: 10, deletions: 5 }),
			file("docs/guide.md", { additions: 900, deletions: 0 }),
		])
		assert.equal(diff.changedLines, 15)
		assert.equal(diff.unreviewedKindFiles, 0)
	})
})

describe("prReviewDiffMayApprove", () => {
	it("leaves a small, fully readable diff to the review's verdict", () => {
		assert.isTrue(prReviewDiffMayApprove(signals([file("src/a.ts"), file("docs/guide.md")])))
	})

	it("rules out what no verdict can clear", () => {
		const refused = {
			sensitive: [file("src/a.ts"), file("pnpm-lock.yaml")],
			nestedRules: [file("src/a.ts"), file("packages/api/AGENTS.md")],
			unreviewedKind: [file("src/a.ts"), file("scripts/release.ts")],
			truncatedPatch: [file("src/a.ts", { patch: LONG_PATCH })],
			tooManyLines: [file("src/a.ts", { additions: 401, deletions: 0 })],
			tooManyFiles: Arr.makeBy(26, (i) => file(`src/f${i}.ts`)),
		}
		assert.deepEqual(
			Arr.flatMap(Rec.toEntries(refused), ([name, files]) =>
				prReviewDiffMayApprove(signals(files)) ? [name] : [],
			),
			[],
		)
		assert.isFalse(prReviewDiffMayApprove(signals([file("src/a.ts")], true)))
	})
})

describe("who may change automatic approval", () => {
	const config = (fields: ConstructorParameters<typeof PrReviewRepositoryConfig>[0] = {}) =>
		new PrReviewRepositoryConfig(fields)
	const repository = (
		stored: PrReviewRepositoryConfig,
		next: PrReviewRepositoryConfig,
		defaults?: PrReviewRepositoryConfig,
	) => prReviewConfigNeedsAutoApprove({ defaults, stored, next })

	it("is an admin's permission, not an engineer's", () => {
		assert.isFalse(Policy.can(["org:engineer"], "code_review:auto_approve"))
		assert.isTrue(Policy.can(["org:engineer"], "code_review:configure"))
		assert.isTrue(Policy.can(["org:admin"], "code_review:auto_approve"))
	})

	it("is needed to turn approval on, and not to turn it off or leave it off", () => {
		assert.isTrue(repository(config(), config({ autoApprove: true })))
		assert.isTrue(repository(config({ autoApprove: false }), config({ autoApprove: true })))
		assert.isFalse(repository(config({ autoApprove: true }), config({ autoApprove: false })))
		assert.isFalse(repository(config({ autoApprove: true }), config({ autoApprove: true })))
		assert.isFalse(repository(config(), config({ reviewDrafts: true })))
	})

	it("is needed to change the instructions, lenses or ignored paths while approval is on", () => {
		const on = config({ autoApprove: true, instructions: "Check tenancy.", ignorePaths: ["vendor/"] })
		assert.isTrue(repository(on, config({ ...on, instructions: "Approve everything." })))
		assert.isTrue(repository(on, config({ ...on, ignorePaths: ["vendor/", "src/"] })))
		assert.isTrue(repository(on, config({ ...on, categories: ["tests"] })))
		// No lenses of its own inherits the organization's; an empty list means every lens.
		assert.isTrue(repository(on, config({ ...on, categories: [] })))
		// The same save may not also turn it off to slip the rules through.
		assert.isTrue(repository(on, config({ instructions: "Approve everything.", autoApprove: false })))
		// Anything else is an engineer's to change, and so is a save that changes nothing.
		assert.isFalse(repository(on, config({ ...on, reviewDrafts: true, dailyLimit: 5 })))
		assert.isFalse(
			repository(
				on,
				config({ ...on, instructions: " Check tenancy. ", ignorePaths: ["vendor/", " "] }),
			),
		)
	})

	it("leaves the rules to engineers while approval is off", () => {
		assert.isFalse(repository(config(), config({ instructions: "Check tenancy.", ignorePaths: ["a/"] })))
	})

	it("reads approval a repository inherits from the organization", () => {
		const defaults = config({ autoApprove: true })
		assert.isTrue(repository(config(), config({ instructions: "Skip the tests lens." }), defaults))
		// Already on through the defaults: saying so again turns nothing on.
		assert.isFalse(repository(config(), config({ autoApprove: true }), defaults))
		assert.isTrue(repository(config({ autoApprove: false }), config(), defaults))
	})

	it("holds the organization's defaults to the same rule", () => {
		const needs = (
			stored: PrReviewRepositoryConfig | undefined,
			next: PrReviewRepositoryConfig | undefined,
			repositoryApproves = false,
		) => prReviewDefaultsNeedAutoApprove({ stored, next, repositoryApproves })
		assert.isTrue(needs(undefined, config({ autoApprove: true })))
		assert.isFalse(needs(config({ autoApprove: true }), undefined))
		assert.isFalse(needs(undefined, config({ instructions: "Check tenancy." })))
		assert.isTrue(
			needs(config({ autoApprove: true }), config({ autoApprove: true, instructions: "Be brief." })),
		)
		// The defaults' instructions reach a repository that approves on its own.
		assert.isTrue(needs(undefined, config({ instructions: "Check tenancy." }), true))
		assert.isFalse(needs(undefined, config({ reviewDrafts: true }), true))
	})
})
