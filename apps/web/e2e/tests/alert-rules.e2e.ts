import { AlertRulePublicId } from "@maple/domain/http/v2"
import { Schema, Array as Arr } from "effect"
import { expect, test } from "playwright/test"

import { api, runTag } from "./support"

interface Tier {
	severity: "warning" | "critical"
	value: number
	upper: number | null
	recovery_value: number | null
	destination_ids: string[]
	escalation_chain_id: string | null
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
		test("keeps an API-made tiered rule intact through UI edits", async ({ page, baseURL }) => {
			const appUrl = baseURL ?? ""
			await page.goto("/alerts")
			const tag = runTag()
			const destination = (name: string) =>
				api<{ id: string }>(page, appUrl, "/v2/alerts/destinations", {
					method: "POST",
					body: {
						type: "webhook",
						name: `e2e ${name} ${tag}`,
						url: "https://example.com/maple-e2e",
					},
				})
			const warn = await destination("warn")
			const pager = await destination("page")
			const tiers: Tier[] = [
				{
					severity: "warning",
					value: 0.007,
					upper: null,
					recovery_value: 0.005,
					destination_ids: [warn.body.id],
					escalation_chain_id: null,
				},
				{
					severity: "critical",
					value: 0.03,
					upper: null,
					recovery_value: null,
					destination_ids: [pager.body.id],
					escalation_chain_id: null,
				},
			]
			const created = await api<Rule>(page, appUrl, "/v2/alerts/rules", {
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
			const read = () => api<Rule>(page, appUrl, `/v2/alerts/rules/${created.body.id}`)

			try {
				await page.goto(editUrl)
				// A saved rule opens as closed cards: each field sits behind its card's summary.
				await page.locator("#sentence-card-condition-summary").click()
				await expect(page.locator("#rule-threshold")).toHaveValue("0.7")
				await expect(page.getByLabel("Critical threshold", { exact: true })).toHaveValue("3")
				await expect(page.getByLabel("Out of the last", { exact: true })).toHaveValue("4")

				await page.locator("#sentence-card-name-summary").click()
				await page.getByLabel("Rule name", { exact: true }).fill(`e2e tiers renamed ${tag}`)
				await page.getByRole("button", { name: "Save changes", exact: true }).click()
				await expect(page).toHaveURL(/\/alerts\/rules$/)
				const renamed = await read()
				expect(renamed.body.name).toBe(`e2e tiers renamed ${tag}`)
				expect(renamed.body.thresholds).toEqual(tiers)
				expect(renamed.body.breaches_out_of).toBe(4)

				await page.goto(editUrl)
				await page.locator("#sentence-card-condition-summary").click()
				await page.getByLabel("Critical threshold", { exact: true }).fill("4")
				await page.getByRole("button", { name: "Save changes", exact: true }).click()
				await expect(page).toHaveURL(/\/alerts\/rules$/)
				const retuned = await read()
				expect(Arr.map(retuned.body.thresholds, (tier) => tier.value)).toEqual([0.007, 0.04])
			} finally {
				await api(page, appUrl, `/v2/alerts/rules/${created.body.id}`, { method: "DELETE" })
				await api(page, appUrl, `/v2/alerts/destinations/${warn.body.id}`, {
					method: "DELETE",
				})
				await api(page, appUrl, `/v2/alerts/destinations/${pager.body.id}`, {
					method: "DELETE",
				})
			}
		})
	}

	test("names an empty range bound before save", async ({ page }) => {
		await page.goto("/alerts/create")
		// The template picker opens first; Cancel closes it on the default rule.
		await page.getByRole("button", { name: "Cancel", exact: true }).click()
		await page.getByLabel("Rule name", { exact: true }).fill(`e2e range ${runTag()}`)
		await page.getByRole("combobox", { name: "Condition", exact: true }).click()
		await page.getByRole("option", { name: "is between", exact: true }).click()

		// The action bar lists what blocks the save, each a link to its field.
		await expect(page.getByText("Fix before saving:", { exact: true })).toBeVisible()
		await expect(page.getByRole("button", { name: "Upper threshold", exact: true })).toBeVisible()
	})

	test("previews a SQL rule", async ({ page }) => {
		await page.goto("/alerts/create")
		// The template picker opens first; Cancel closes it on the default rule.
		await page.getByRole("button", { name: "Cancel", exact: true }).click()
		await page.getByRole("button", { name: "SQL", exact: true }).click()

		await expect(page.getByText(/^Breach above/)).toBeVisible({ timeout: 45_000 })
		await expect(page.getByText("Preview query failed", { exact: true })).toBeHidden()
	})
})
