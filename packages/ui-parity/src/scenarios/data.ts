import type { AreaModule } from "./types.ts"

/**
 * S6 data layer probe (`apps/web-foldkit/src/lab/entries/data-probe.ts`). Foldkit only: it has
 * no legacy twin (so `targets` skips it elsewhere): `parity capture foldkit --filter data-probe`, then read the
 * call log in the variant JSON (one execute-batch item, one `alert_rules` shape, 0 unmocked).
 */
export const dataArea: AreaModule = {
	area: "data",
	scenarios: [
		{
			id: "data-probe",
			title: "Lab: S6 data probe (Foldkit only)",
			path: "/lab/data-probe",
			dataset: "default",
			targets: ["foldkit"],
			viewports: ["desktop"],
			themes: ["light"],
			area: "data",
			steps: async (page) => {
				await page.getByText(/^Services: \d+$/).waitFor()
				await page.getByText(/^Alert rules: \d+$/).waitFor()
			},
		},
	],
}
