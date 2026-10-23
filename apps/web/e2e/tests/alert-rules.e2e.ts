import { AlertRulePublicId } from "@maple/domain/http/v2"
import { test } from "@e2e-dev/web"
import { Schema } from "effect"
import { expect } from "e2e"

import { api, runTag } from "./support"

interface Tier {
	severity: "warning" | "critical"
	value: number
	upper: number | null
	recovery_value: number | null
	destination_ids: string[]
}
interface Rule {
	id: string
	name: string
	thresholds: Tier[]
	consecutive_breaches_required: number
	breaches_out_of: number | null
}

const toRuleUuid = Schema.decodeSync(AlertRulePublicId)

test.describe("alert rules", () => {
	// Editing loads the rule over Electric sync, which a `preview:web` preview does not deploy.
	if (process.env.MAPLE_E2E_NO_SYNC !== "1") {
		// A rule written by the API or MCP, then edited in the UI: the path that dropped tiers.
		test(
			"keeps an API-made tiered rule intact through UI edits",
			{ session: "reviewer" },
			async ({ app, browser, screen }) => {
				const appUrl = app.baseUrl ?? ""
				await app.open("/alerts")
				const tag = runTag()
				const destination = (name: string) =>
					api<{ id: string }>(browser, appUrl, "/v2/alerts/destinations", {
						method: "POST",
						body: {
							type: "webhook",
							name: `e2e ${name} ${tag}`,
							url: "https://example.com/maple-e2e",
						},
					})
				const warn = await destination("warn")
				const page = await destination("page")
				const tiers: Tier[] = [
					{
						severity: "warning",
						value: 0.007,
						upper: null,
						recovery_value: 0.005,
						destination_ids: [warn.body.id],
					},
					{
						severity: "critical",
						value: 0.03,
						upper: null,
						recovery_value: null,
						destination_ids: [page.body.id],
					},
				]
				const created = await api<Rule>(browser, appUrl, "/v2/alerts/rules", {
					method: "POST",
					body: {
						name: `e2e tiers ${tag}`,
						signal_type: "error_rate",
						comparator: "gt",
						window_minutes: 5,
						consecutive_breaches_required: 2,
						breaches_out_of: 4,
						thresholds: tiers,
					},
				})
				expect(created.status).toBe(200)
				const editUrl = `/alerts/create?ruleId=${toRuleUuid(created.body.id)}`
				const read = () => api<Rule>(browser, appUrl, `/v2/alerts/rules/${created.body.id}`)

				try {
					await app.open(editUrl)
					await expect(browser.locator("#rule-threshold")).toHaveValue("0.7")
					await expect(screen.getByLabel("Critical threshold")).toHaveValue("3")
					await expect(screen.getByLabel("Out of the last")).toHaveValue("4")

					await screen.getByLabel("Rule name").fill(`e2e tiers renamed ${tag}`)
					await screen.getByRole("button", "Save changes").tap()
					await expect(browser).toHaveURL(/\/alerts$/)
					const renamed = await read()
					expect(renamed.body.name).toBe(`e2e tiers renamed ${tag}`)
					expect(renamed.body.thresholds).toEqual(tiers)
					expect(renamed.body.breaches_out_of).toBe(4)

					await app.open(editUrl)
					await screen.getByLabel("Critical threshold").fill("4")
					await screen.getByRole("button", "Save changes").tap()
					await expect(browser).toHaveURL(/\/alerts$/)
					const retuned = await read()
					expect(retuned.body.thresholds.map((tier) => tier.value)).toEqual([0.007, 0.04])
				} finally {
					await api(browser, appUrl, `/v2/alerts/rules/${created.body.id}`, { method: "DELETE" })
					await api(browser, appUrl, `/v2/alerts/destinations/${warn.body.id}`, {
						method: "DELETE",
					})
					await api(browser, appUrl, `/v2/alerts/destinations/${page.body.id}`, {
						method: "DELETE",
					})
				}
			},
		)
	}

	test("names an empty range bound before save", { session: "reviewer" }, async ({ app, screen }) => {
		await app.open("/alerts/create")
		await screen.getByRole("button", /^Skip/).tap()
		await screen.getByLabel("Rule name").fill(`e2e range ${runTag()}`)
		await screen.getByRole("combobox", "Alert when the value").tap()
		await screen.getByRole("option", "is between").tap()

		await expect(screen.getByText(/^Fix before saving:/)).toContainText("Upper threshold")
	})

	test("previews a SQL rule", { session: "reviewer" }, async ({ app, screen }) => {
		await app.open("/alerts/create")
		await screen.getByRole("button", /^Skip/).tap()
		await screen.getByRole("button", "SQL").tap()

		await expect(screen.getByText(/^Breach above/)).toBeVisible({ timeout: 45_000 })
		await expect(screen.getByText("Preview query failed")).toBeHidden()
	})

	// The agent fixture needs a model, so this one only registers when there is one.
	if (process.env.ANTHROPIC_API_KEY) {
		test(
			"draws both tier lines on the chart",
			{ session: "reviewer" },
			async ({ agent, app, screen }) => {
				await app.open("/alerts/create")
				await screen.getByRole("button", /^Skip/).tap()
				await screen.getByRole("button", "Add critical tier").tap()

				await expect(screen.getByText(/^Critical above/)).toBeVisible({ timeout: 45_000 })
				await agent.assert(
					"The preview chart shows two dashed horizontal threshold lines: an amber one and a red one higher up",
				)
			},
		)
	}
})
