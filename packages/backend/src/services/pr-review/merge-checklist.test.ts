import {
	GitCommitSha,
	mergeStepKey,
	mergeStepTickChanges,
	PrReviewMergeStep,
	PrReviewReport,
	parseMergeStepTicks,
	type PullRequestFile,
} from "@maple/domain/http"
import { Schema } from "effect"
import { assert, describe, it } from "vitest"
import {
	buildChecklist,
	checklistAttributes,
	detectMergeSteps,
	type NameVerdict,
	reconcileMergeSteps,
	searchVerdict,
	type StoredMergeStep,
} from "./merge-checklist"
import { renderMergeReminder, renderSummaryComment } from "./PrReviewService"

const file = (
	path: string,
	patch: string | null,
	status: PullRequestFile["status"] = "modified",
): PullRequestFile => ({
	path,
	previousPath: null,
	status,
	additions: 1,
	deletions: 0,
	patch,
})

const names = (files: ReadonlyArray<PullRequestFile>) =>
	detectMergeSteps(files).names.map((candidate) => `${candidate.kind}:${candidate.name}`)

describe("detectMergeSteps", () => {
	it("reads secrets and env vars from config helpers and runtime reads, with head line numbers", () => {
		const detected = detectMergeSteps([
			file(
				"packages/infra/src/env.ts",
				[
					"@@ -10,2 +10,5 @@",
					" const a = 1",
					'+\toptionalSecret("STRIPE_WEBHOOK_SECRET"),',
					'+\toptionalPlain("STRIPE_REGION"),',
					'+const url = process.env.BILLING_URL ?? Config.redacted("BILLING_SIGNING")',
					" const b = 2",
				].join("\n"),
			),
		])
		assert.deepEqual(
			detected.names.map((candidate) => [candidate.kind, candidate.name, candidate.line]),
			[
				["secret", "STRIPE_WEBHOOK_SECRET", 11],
				["env", "STRIPE_REGION", 12],
				["env", "BILLING_URL", 13],
				["secret", "BILLING_SIGNING", 13],
			],
		)
	})

	it("reads a name held in a constant named for config, and not one held in any constant", () => {
		assert.deepEqual(
			names([
				file(
					"packages/chat-platform/src/connectors/slack/api.ts",
					[
						"@@ -1 +1,4 @@",
						'+export const CLIENT_ID_CONFIG = "MAPLE_SLACK_CLIENT_ID"',
						'+export const SIGNING_SECRET_CONFIG: string = "MAPLE_SLACK_SIGNING_SECRET"',
						'+const BOT_TOKEN = "MAPLE_SLACK_BOT"',
						'+export const DEFAULT_LABEL = "READY_TO_SHIP"',
					].join("\n"),
				),
			]),
			["env:MAPLE_SLACK_CLIENT_ID", "secret:MAPLE_SLACK_SIGNING_SECRET", "secret:MAPLE_SLACK_BOT"],
		)
	})

	it("skips names a removed line still mentions, names every runtime provides, and tests", () => {
		assert.deepEqual(
			names([
				file("src/a.ts", "@@ -1 +1 @@\n-const k = process.env.OLD_KEY\n+const k = Bun.env.OLD_KEY"),
				file("src/b.ts", "@@ -1 +1 @@\n+if (process.env.NODE_ENV === 'x') {}"),
				file("apps/ai/scripts/run.ts", "@@ -1 +1 @@\n+const key = process.env.LOCAL_API_KEY"),
				file("src/b.test.ts", "@@ -1 +1 @@\n+process.env.TEST_ONLY_TOKEN = 'x'"),
			]),
			[],
		)
	})

	it("reads CI secrets and variables from workflows, and keys from env templates", () => {
		const detected = detectMergeSteps([
			file(
				".github/workflows/deploy.yml",
				"@@ -1 +1,2 @@\n+  token: ${{ secrets.DEPLOY_TOKEN }}\n+  region: ${{ vars.DEPLOY_REGION }}",
			),
			file(".env.example", "@@ -1 +1,2 @@\n+RESEND_API_KEY=\n+APP_NAME=maple"),
		])
		assert.deepEqual(
			detected.names.map((candidate) => [candidate.kind, candidate.name, candidate.ci]),
			[
				["secret", "DEPLOY_TOKEN", true],
				["env", "DEPLOY_REGION", true],
				["secret", "RESEND_API_KEY", false],
				["env", "APP_NAME", false],
			],
		)
	})

	it("lists added migrations, warehouse schema and deployment config by file", () => {
		const { steps } = detectMergeSteps([
			file(
				"packages/db/drizzle/20261008_pr_steps/migration.sql",
				"@@ -0,0 +1 @@\n+ALTER TABLE x",
				"added",
			),
			file("packages/db/drizzle/20261008_pr_steps/snapshot.json", "@@ -0,0 +1 @@\n+{}", "added"),
			file("packages/domain/src/tinybird/datasources.ts", "@@ -1 +1 @@\n+x"),
			file("apps/api/wrangler.jsonc", "@@ -1 +1 @@\n+x"),
			file("old/Dockerfile", null, "removed"),
		])
		assert.deepEqual(
			steps.map((step) => step.kind),
			["migration", "warehouse", "infra"],
		)
	})
})

const checklistOf = (
	files: ReadonlyArray<PullRequestFile>,
	verdicts: Readonly<Record<string, NameVerdict>> = {},
	reviewer: ReadonlyArray<PrReviewMergeStep> = [],
	ignored: ReadonlyArray<string> = [],
) =>
	buildChecklist({
		detected: detectMergeSteps(files),
		verdicts: new Map(Object.entries(verdicts)),
		reviewer,
		isIgnored: (path) => ignored.includes(path),
	})

const envFile = file(
	"src/env.ts",
	'@@ -1 +1,3 @@\n+optionalSecret("STRIPE_KEY")\n+optionalPlain("STRIPE_URL")\n+optionalPlain("STRIPE_REGION")',
)
const wrangler = file("apps/api/wrangler.jsonc", "@@ -1 +1 @@\n+x")

describe("searchVerdict", () => {
	it("counts a hit only when it holds the whole name, or no text to check", () => {
		assert.equal(searchVerdict("STRIPE_KEY", []), "new")
		assert.equal(searchVerdict("STRIPE_KEY", [{ snippets: ["STRIPE_KEY_ID", "MY_STRIPE_KEY"] }]), "new")
		assert.equal(searchVerdict("STRIPE_KEY", [{ snippets: ['env("STRIPE_KEY")'] }]), "exists")
		assert.equal(searchVerdict("STRIPE_KEY", [{ snippets: [] }]), "exists")
	})
})

describe("buildChecklist", () => {
	it("drops names the default branch reads and keeps new and unverified ones, secrets first", () => {
		const { steps, trace } = checklistOf([wrangler, envFile], { STRIPE_KEY: "new", STRIPE_URL: "exists" })
		assert.deepEqual(
			steps.map((step) => [step.kind, step.subject]),
			[
				["secret", "STRIPE_KEY"],
				["env", "STRIPE_REGION"],
				["infra", "apps/api/wrangler.jsonc"],
			],
		)
		assert.deepEqual(trace.names, [
			{ name: "STRIPE_KEY", verdict: "new" },
			{ name: "STRIPE_URL", verdict: "exists" },
			{ name: "STRIPE_REGION", verdict: "unverified" },
		])
	})

	it("replaces a diff step with a reviewer step that names its subject exactly", () => {
		const reviewer = [
			new PrReviewMergeStep({
				kind: "manual",
				title: "Add `STRIPE_KEY` to the prd and dev secret stores",
				source: "reviewer",
			}),
			new PrReviewMergeStep({ kind: "manual", title: "Update wrangler bindings", source: "reviewer" }),
		]
		const { steps, trace } = checklistOf([wrangler, envFile], { STRIPE_URL: "exists" }, reviewer)
		// "wrangler" alone is not the file's subject, so the infra step stays.
		assert.deepEqual(trace.replaced, ["STRIPE_KEY"])
		// The replacement keeps the secret's identity, so its tick carries and it still sorts first.
		assert.deepEqual(
			steps.map((step) => [step.source, step.kind, step.subject]),
			[
				["reviewer", "secret", "STRIPE_KEY"],
				["diff", "env", "STRIPE_REGION"],
				["diff", "infra", "apps/api/wrangler.jsonc"],
				["reviewer", "manual", undefined],
			],
		)
		assert.equal(steps[0]?.title, "Add `STRIPE_KEY` to the prd and dev secret stores")
	})

	it("drops steps under ignored paths and records them", () => {
		const { steps, trace } = checklistOf([wrangler], {}, [], ["apps/api/wrangler.jsonc"])
		assert.deepEqual(steps, [])
		assert.deepEqual(trace.ignored, ["apps/api/wrangler.jsonc"])
	})

	it("states every decision as span attributes", () => {
		const attributes = checklistAttributes(
			"read",
			checklistOf([wrangler, envFile], { STRIPE_KEY: "new", STRIPE_URL: "exists" }),
		)
		assert.deepInclude(attributes, {
			"maple.pr_review.checklist.status": "read",
			"maple.pr_review.checklist.steps": 3,
			"maple.pr_review.checklist.names_new": "STRIPE_KEY",
			"maple.pr_review.checklist.names_exists": "STRIPE_URL",
			"maple.pr_review.checklist.names_unverified": "STRIPE_REGION",
			"maple.pr_review.checklist.file_steps": 1,
		})
	})
})

describe("the Before merge section", () => {
	it("renders as a task list with links to the line, under the summary", () => {
		const report = new PrReviewReport({
			verdict: "clean",
			summary: "Adds Stripe webhooks.",
			coverage: [],
			findings: [],
			beforeMerge: checklistOf([envFile], { STRIPE_URL: "exists", STRIPE_REGION: "exists" }).steps,
		})
		const body = renderSummaryComment("<!-- m -->", {
			report,
			partial: false,
			headSha: Schema.decodeSync(GitCommitSha)("a".repeat(40)),
			repositoryUrl: "https://github.com/acme/shop",
		})
		assert.include(body, "### Before merge")
		assert.include(
			body,
			`- [ ] **Secret** · Add secret \`STRIPE_KEY\` to every environment · [\`src/env.ts:1\`](https://github.com/acme/shop/blob/${"a".repeat(40)}/src/env.ts#L1)`,
		)
		assert.isBelow(body.indexOf("Adds Stripe webhooks."), body.indexOf("### Before merge"))
	})
})

const stored = (key: string, status: StoredMergeStep["status"], extra: Partial<StoredMergeStep> = {}) => ({
	key,
	kind: "manual" as const,
	title: key,
	status,
	doneBy: null,
	...extra,
})

const manual = (title: string) => new PrReviewMergeStep({ kind: "manual", title, source: "reviewer" })

describe("reconcileMergeSteps", () => {
	it("keys every step, marks ticked ones done, and obsoletes open steps the head dropped", () => {
		const { steps } = checklistOf([envFile], { STRIPE_URL: "exists", STRIPE_REGION: "exists" })
		const result = reconcileMergeSteps(steps, [
			stored("secret:STRIPE_KEY", "done", { kind: "secret", doneBy: "christo" }),
			stored("env:OLD_FLAG", "open", { kind: "env" }),
			stored("env:SHIPPED", "done", { kind: "env" }),
		])
		assert.deepEqual(
			result.steps.map((step) => [step.key, step.done, step.doneBy]),
			[["secret:STRIPE_KEY", true, "christo"]],
		)
		// A done step is never taken back, even when the head stops producing it.
		assert.deepEqual(result.obsolete, ["env:OLD_FLAG"])
	})

	it("keeps a reworded manual step's tick, and never folds two different steps into one", () => {
		const backfill = "Run the `issues_v3` backfill once the deploy is live"
		const result = reconcileMergeSteps(
			[
				manual("Run the issues_v3 backfill after deploying"),
				manual("Create the `prreview` flag in Clerk"),
			],
			[stored(mergeStepKey(manual(backfill)), "done", { title: backfill, doneBy: "david" })],
		)
		assert.deepEqual(
			result.steps.map((step) => step.done === true),
			[true, false],
		)
		assert.equal(result.steps[0]?.key, mergeStepKey(manual(backfill)))
		assert.deepEqual(result.obsolete, [])
	})

	it("does not match a manual step on the subject alone", () => {
		const result = reconcileMergeSteps(
			[manual("Run the migration for STRIPE_EVENTS")],
			[stored("manual:old", "open", { title: "Run the backfill for STRIPE_EVENTS" })],
		)
		assert.notEqual(result.steps[0]?.key, "manual:old")
		assert.deepEqual(result.obsolete, ["manual:old"])
	})
})

describe("ticks on the comment", () => {
	const report = (beforeMerge: ReadonlyArray<PrReviewMergeStep>) =>
		renderSummaryComment("<!-- maple-pr-review r 0 -->", {
			report: new PrReviewReport({
				verdict: "clean",
				summary: "s",
				coverage: [],
				findings: [],
				beforeMerge,
			}),
			partial: false,
			headSha: Schema.decodeSync(GitCommitSha)("a".repeat(40)),
			repositoryUrl: "https://github.com/acme/shop",
		})

	it("tags each task with its key and renders a done step ticked", () => {
		const { steps } = reconcileMergeSteps(
			checklistOf([envFile], { STRIPE_URL: "exists", STRIPE_REGION: "exists" }).steps,
			[stored("secret:STRIPE_KEY", "done", { kind: "secret", doneBy: "christo" })],
		)
		const body = report(steps)
		assert.match(body, /- \[x\] \*\*Secret\*\* .* · ticked by @christo <!-- ms:secret:STRIPE_KEY -->/)
		assert.deepEqual([...parseMergeStepTicks(body)], [["secret:STRIPE_KEY", true]])
	})

	it("reads a person's tick as the boxes that changed, and nothing from a re-render", () => {
		const before = report([
			manual("Create the flag"),
			new PrReviewMergeStep({ ...manual("Set X"), key: "env:X" }),
		])
		const after = before.replace(
			"- [ ] **Manual** · Create the flag",
			"- [x] **Manual** · Create the flag",
		)
		assert.deepEqual(mergeStepTickChanges(before, after), [{ key: "manual:create-the-flag", done: true }])
		assert.deepEqual(mergeStepTickChanges(after, before), [
			{ key: "manual:create-the-flag", done: false },
		])
		assert.deepEqual(mergeStepTickChanges(before, before), [])
		assert.deepEqual(mergeStepTickChanges(before, `${before}\n- [x] spoof <!-- ms:secret:NEW -->`), [])
	})

	it("reminds at merge with every open step", () => {
		const body = renderMergeReminder([
			{ kind: "secret", title: "Add secret `FOO` to every environment" },
			{ kind: "manual", title: "Run the backfill" },
		])
		assert.include(body, "Merged with 2 steps")
		assert.include(body, "- **Secret** · Add secret `FOO` to every environment")
	})
})
