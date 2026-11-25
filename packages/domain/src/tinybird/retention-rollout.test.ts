import { Array as Arr, Effect, Option, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import { buildTinybirdProjectManifest } from "./project-manifest"
import { RETENTION_ROLLOUT_PENDING } from "./retention-rollout"

// Once the RetentionDays deploy is live in every workspace, set RETENTION_ROLLOUT_PENDING to
// false: these hold the one-shot config to it, so the flip reverts all of it at once.
describe("RetentionDays rollout config", () => {
	const manifest = Effect.runSync(buildTinybirdProjectManifest)
	const forwardQueryOf = (content: string) => Str.split(content, "FORWARD_QUERY >\n")[1] ?? ""
	const contentOf = (resources: typeof manifest.datasources, name: string) =>
		Option.map(
			Arr.findFirst(resources, (resource) => resource.name === name),
			(resource) => resource.content,
		)

	it("stamps existing rows in forward queries only while the rollout is pending", () => {
		const stamping = Arr.filter(manifest.datasources, (datasource) =>
			Str.includes("AS RetentionDays")(forwardQueryOf(datasource.content)),
		)
		expect(Arr.isArrayNonEmpty(stamping)).toBe(RETENTION_ROLLOUT_PENDING)
	})

	it("holds `alter` off the trace views only while the rollout is pending", () => {
		const views = ["service_overview_spans_mv", "ai_trace_index_mv", "scanner_requests_mv"]
		const withAlter = Arr.filter(views, (name) =>
			Option.exists(contentOf(manifest.pipes, name), Str.includes("DEPLOYMENT_METHOD alter")),
		)
		expect(withAlter).toEqual(RETENTION_ROLLOUT_PENDING ? [] : views)
	})

	it("always copies product_events forward, so a deploy never rebuilds it from its sources", () => {
		const content = contentOf(manifest.datasources, "product_events")
		expect(Option.exists(content, (text) => forwardQueryOf(text) !== "")).toBe(true)
	})
})
