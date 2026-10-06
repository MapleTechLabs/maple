import type { PullRequestFile } from "@maple/domain/http"
import { assert, describe, it } from "vitest"
import { analyzeTelemetry, EMPTY_CATALOG, frameMatchesPath, type TelemetryCatalog } from "./analyze"
import { emittedNames, parsePatch } from "./diff"
import { referencesFor, textsOf, type ReferenceSource } from "./references"

const file = (path: string, patch: string): PullRequestFile => ({
	path,
	previousPath: null,
	status: "modified",
	additions: 1,
	deletions: 1,
	patch,
})

const catalog: TelemetryCatalog = {
	...EMPTY_CATALOG,
	windowDays: 7,
	operations: [
		{ service: "api", spanName: "POST /checkout", count: 70_000, errorCount: 700, p95Ms: 320 },
		{ service: "api", spanName: "Payments.charge", count: 7_000, errorCount: 0, p95Ms: 90 },
	],
	attributeKeys: new Map([
		["http.route", 1_400_000],
		["payment.provider", 7_000],
	]),
	metricNames: new Map([["payments.charged", 2_100]]),
}

const alert: ReferenceSource = {
	kind: "alert",
	id: "rule-1",
	name: "Checkout by provider",
	texts: ["payment.provider = 'stripe'", "traces"],
}
const dashboard: ReferenceSource = {
	kind: "dashboard",
	id: "dash-1",
	name: "Payments",
	texts: ["attr.payments.charged.total", "Payments.charge"],
}

describe("parsePatch", () => {
	it("numbers added lines on the new side and anchors removals where they happened", () => {
		const lines = parsePatch("@@ -10,3 +20,3 @@\n a\n-b\n+c\n d")
		assert.deepStrictEqual(
			lines.map((line) => [line.kind, line.newLine]),
			[
				["ctx", 20],
				["del", 21],
				["add", 21],
				["ctx", 22],
			],
		)
	})
})

describe("emittedNames", () => {
	it("classifies span, metric and attribute names by the call they are in", () => {
		assert.deepStrictEqual(
			emittedNames(`Effect.withSpan("Payments.charge"), Metric.counter("payments.charged")`, "").map(
				(name) => [name.kind, name.value],
			),
			[
				["span", "Payments.charge"],
				["metric", "payments.charged"],
			],
		)
		assert.deepStrictEqual(
			emittedNames(`	"payment.provider": provider,`, "yield* Effect.annotateCurrentSpan({").map(
				(name) => name.value,
			),
			["payment.provider"],
		)
		assert.deepStrictEqual(emittedNames(`const label = "payment.provider"`, ""), [])
	})
})

describe("referencesFor", () => {
	it("does not match a route inside a longer route", () => {
		const routes: ReferenceSource = {
			kind: "dashboard",
			id: "d",
			name: "d",
			texts: ["GET /checkout/confirm"],
		}
		assert.lengthOf(referencesFor("/checkout", [routes]), 0)
		assert.lengthOf(referencesFor("/checkout/confirm", [routes]), 1)
	})

	it("matches whole tokens, behind attr. prefixes, and not inside longer names", () => {
		assert.lengthOf(referencesFor("payment.provider", [alert]), 1)
		assert.lengthOf(referencesFor("payments.charged", [dashboard]), 0)
		assert.lengthOf(referencesFor("payments.charged.total", [dashboard]), 1)
		assert.lengthOf(referencesFor("payment", [alert]), 0)
	})

	it("reads every string of a stored document", () => {
		assert.deepStrictEqual(textsOf({ a: ["x", { b: "y" }], c: 1, d: null }), ["x", "y"])
	})
})

describe("frameMatchesPath", () => {
	it("reads a file name with regex characters literally", () => {
		assert.isFalse(frameMatchesPath("at x (/s.js)", "apps/web/src/routes/[...slug].tsx"))
		assert.isTrue(frameMatchesPath("at x (/app/[...slug].js)", "apps/web/src/routes/[...slug].tsx"))
		assert.isFalse(frameMatchesPath("at x (/app/other.js)", "src/c++module.ts"))
	})

	it("ties a frame to a file by its directory and name, ignoring the extension", () => {
		assert.isTrue(frameMatchesPath("at charge (/app/dist/payments/charge.js)", "src/payments/charge.ts"))
		assert.isFalse(frameMatchesPath("at handler (/app/dist/users/index.js)", "src/payments/index.ts"))
		assert.isTrue(frameMatchesPath("at x (/app/checkout-flow.js)", "src/web/checkout-flow.ts"))
	})
})

describe("analyzeTelemetry", () => {
	it("reports a removed name an alert reads as a contract break", () => {
		const telemetry = analyzeTelemetry({
			files: [
				file(
					"src/payments/charge.ts",
					`@@ -1,3 +1,2 @@\n Effect.withSpan("Payments.charge")\n-span.setAttribute("payment.provider", p)\n+span.setAttribute("provider", p)`,
				),
			],
			catalog,
			sources: [alert, dashboard],
			issues: [],
		})
		assert.deepStrictEqual(
			telemetry.contractBreaks.map((item) => [item.name, item.kind, item.line, item.perDay]),
			[["payment.provider", "attribute", 2, 1_000]],
		)
		assert.deepStrictEqual(
			telemetry.contractBreaks[0]?.references.map((ref) => ref.id),
			["rule-1"],
		)
		assert.deepStrictEqual(
			telemetry.added.map((item) => item.name),
			[],
		)
	})

	it("does not report a name the pull request adds back elsewhere", () => {
		const telemetry = analyzeTelemetry({
			files: [
				file("src/a.ts", `@@ -1,1 +1,0 @@\n-span.setAttribute("payment.provider", p)`),
				file("src/b.ts", `@@ -1,0 +1,1 @@\n+span.setAttribute("payment.provider", p)`),
			],
			catalog,
			sources: [alert],
			issues: [],
		})
		assert.lengthOf(telemetry.contractBreaks, 0)
		assert.lengthOf(telemetry.removed, 0)
	})

	it("does not count a name quoted in a comment or a log message as added back", () => {
		const telemetry = analyzeTelemetry({
			files: [
				file(
					"src/a.ts",
					`@@ -1,1 +1,2 @@\n-span.setAttribute("payment.provider", p)\n+// was "payment.provider"\n+console.log("payment.provider", p)`,
				),
			],
			catalog,
			sources: [alert],
			issues: [],
		})
		assert.deepStrictEqual(
			telemetry.contractBreaks.map((item) => item.name),
			["payment.provider"],
		)
	})

	it("ignores tests and docs", () => {
		const telemetry = analyzeTelemetry({
			files: [file("src/a.test.ts", `@@ -1,1 +1,0 @@\n-span.setAttribute("payment.provider", p)`)],
			catalog,
			sources: [alert],
			issues: [],
		})
		assert.lengthOf(telemetry.contractBreaks, 0)
	})

	it("weighs a file by the production operations it names, routes included", () => {
		const telemetry = analyzeTelemetry({
			files: [
				file(
					"src/routes/checkout.ts",
					`@@ -1,1 +1,2 @@\n app.post("/checkout", handler)\n+console.log("charging", order)`,
				),
			],
			catalog: { ...catalog, bytesPerLogRecord: 1_000 },
			sources: [],
			issues: [],
		})
		assert.deepStrictEqual(
			telemetry.hotFiles.map((hot) => [hot.path, hot.perDay]),
			[["src/routes/checkout.ts", 10_000]],
		)
		assert.deepStrictEqual(telemetry.services, ["api"])
		assert.deepStrictEqual(
			telemetry.costNotes.map((note) => [note.kind, note.gbPerMonth]),
			[["log", 0.3]],
		)
	})

	it("flags a span name built from a value", () => {
		const telemetry = analyzeTelemetry({
			files: [file("src/a.ts", "@@ -1,0 +1,1 @@\n+Effect.withSpan(`charge ${userId}`)")],
			catalog,
			sources: [],
			issues: [],
		})
		assert.deepStrictEqual(
			telemetry.costNotes.map((note) => note.kind),
			["span_name"],
		)
	})

	it("links open issues whose top frame is in a changed file", () => {
		const telemetry = analyzeTelemetry({
			files: [file("src/payments/charge.ts", "@@ -1,1 +1,1 @@\n-a\n+b")],
			catalog,
			sources: [],
			issues: [
				{
					id: "issue-1",
					fingerprintHash: "123",
					title: "TypeError: x is undefined",
					service: "api",
					topFrame: "at charge (/app/payments/charge.js)",
					occurrences: 40,
					lastSeenAt: 1,
				},
			],
		})
		assert.deepStrictEqual(
			telemetry.linkedIssues.map((issue) => [issue.issueId, issue.path]),
			[["issue-1", "src/payments/charge.ts"]],
		)
	})
})
