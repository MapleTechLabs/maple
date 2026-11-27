import { describe, expect, it } from "vitest"
import { GET as featureMd } from "../pages/features/[slug].md"
import { GET as llmsTxt } from "../pages/llms.txt"
import { featureBySlug, features } from "../lib/features"
import type { Feature } from "../lib/page-registry"

type Context = Parameters<typeof featureMd>[0]

const render = async (route: typeof featureMd, props: Context["props"] = {}) => {
	const context = { site: new URL("https://maple.dev"), props } as Context
	const response = await route(context)
	return response.text()
}

const renderFeature = (slug: string) => {
	const feature: Feature | undefined = featureBySlug(slug)
	if (!feature) throw new Error(`no feature ${slug}`)
	return render(featureMd, { feature })
}

describe("feature page markdown twins", () => {
	it.each(features.map((feature) => feature.slug))(
		"%s states the plan price and the scale proof",
		async (slug) => {
			const text = await renderFeature(slug)
			expect(text).toMatch(/- \*\*plan\*\*: Startup, \$39\/month/)
			expect(text).toContain("](https://maple.dev/customers/superwall)")
			expect(text).toContain("](https://maple.dev/pricing.md)")
		},
	)

	it("quotes the per-GB rate on a metered feature and the retention period", async () => {
		const text = await renderFeature("log-management")
		expect(text).toContain("Logs: 100 GB included, then $0.30 / GB")
		expect(text).toMatch(/- \*\*retention\*\*: Log lines 30 days/)
		expect(text).toContain("](https://maple.dev/docs/explore/logs.md)")
	})

	it("bills code review against AI usage", async () => {
		const text = await renderFeature("github")
		expect(text).toMatch(/- \*\*billed as\*\*: AI usage: \$1 included, then billed per model/)
	})

	it("says an unmetered feature has no separate charge", async () => {
		const text = await renderFeature("alerts")
		expect(text).toMatch(/- \*\*billed as\*\*: No separate meter/)
	})

	it("carries the install commands the HTML page shows", async () => {
		const text = await renderFeature("kubernetes-monitoring")
		expect(text).toContain("helm upgrade --install maple-k8s-infra")
		expect(text).toContain("```bash")
	})

	it("carries the product event snippets with their docs links", async () => {
		const text = await renderFeature("product-events")
		expect(text).toContain('MapleBrowser.track("checkout_completed"')
		expect(text).toContain("](https://maple.dev/docs/product-events/api)")
	})
})

describe("llms.txt features section", () => {
	it("counts every feature page in the registry", async () => {
		const text = await render(llmsTxt)
		expect(text).toContain(`One page per capability, ${features.length} in all.`)
	})
})
