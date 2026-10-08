import { GitCommitSha, PrReviewMergeStep, PrReviewReport, type PullRequestFile } from "@maple/domain/http"
import { Schema } from "effect"
import { assert, describe, it } from "vitest"
import { detectMergeSteps, mergeChecklist, nameStep } from "./merge-checklist"
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
		assert.include(nameStep(detected.names[0]!).title, "CI secrets")
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

describe("mergeChecklist", () => {
	const diff = [
		new PrReviewMergeStep({
			kind: "infra",
			title: "Deployment config changed in `wrangler.jsonc`",
			source: "diff",
		}),
		nameStep({ name: "STRIPE_KEY", kind: "secret", ci: false, path: "src/env.ts", line: 3 }),
	]

	it("orders secrets first and lets a reviewer step that names a subject replace it", () => {
		const reviewer = [
			new PrReviewMergeStep({
				kind: "manual",
				title: "Add `STRIPE_KEY` to the prd and dev secret stores",
				source: "reviewer",
			}),
		]
		assert.deepEqual(
			mergeChecklist(diff, reviewer).map((step) => step.source),
			["diff", "reviewer"],
		)
		assert.deepEqual(
			mergeChecklist(diff, []).map((step) => step.kind),
			["secret", "infra"],
		)
	})
})

describe("the Before merge section", () => {
	it("renders as a task list with links to the line, under the summary", () => {
		const report = new PrReviewReport({
			verdict: "clean",
			summary: "Adds Stripe webhooks.",
			coverage: [],
			findings: [],
			beforeMerge: [
				nameStep({ name: "STRIPE_KEY", kind: "secret", ci: false, path: "src/env.ts", line: 3 }),
			],
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
			`- [ ] **Secret** · Add the secret \`STRIPE_KEY\` to every environment this deploys to · [\`src/env.ts:3\`](https://github.com/acme/shop/blob/${"a".repeat(40)}/src/env.ts#L3)`,
		)
		assert.isBelow(body.indexOf("Adds Stripe webhooks."), body.indexOf("### Before merge"))
	})
})
