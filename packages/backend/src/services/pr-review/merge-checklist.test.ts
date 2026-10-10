import { GitCommitSha, PrReviewMergeStep, PrReviewReport, type PullRequestFile } from "@maple/domain/http"
import { Schema } from "effect"
import { assert, describe, it } from "vitest"
import {
	buildChecklist,
	checklistAttributes,
	detectMergeSteps,
	type NameVerdict,
	searchVerdict,
} from "./merge-checklist"
import { renderSummaryComment } from "./PrReviewService"

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
		assert.deepEqual(
			steps.map((step) => step.source),
			["diff", "diff", "reviewer", "reviewer"],
		)
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
