// TEST-SEAM: the atom client is process-global wiring with no instance-level
// injection seam, so the mutation is replaced at the module boundary and the
// table is exercised through its rendered controls.
import { useState } from "react"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { Exit } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	BillingControls,
	type BillingCustomer,
	type BillingUsage,
	type CatalogPlan,
	type UpdateBillingControlsRequest,
} from "@maple/domain/http"

interface SaveCapsArgs {
	readonly payload: UpdateBillingControlsRequest
	readonly reactivityKeys: ReadonlyArray<string>
}

const saveCaps = vi.fn<(args: SaveCapsArgs) => Promise<Exit.Exit<BillingControls, never>>>()
vi.mock("@/lib/effect-atom", () => ({ useAtomSet: () => saveCaps }))
vi.mock("@/lib/services/atoms/billing-atoms", () => ({
	BILLING_CUSTOMER_KEY: "billing-customer",
	updateBillingControlsMutation: {},
}))

import { buildSpendModel, type SpendFeatureId } from "@/lib/billing/spend"
import { BillingUsageTable } from "./billing-usage-table"

const startup = {
	id: "startup",
	name: "Startup",
	price: { amount: 39, interval: "month" },
	items: [
		{ featureId: "logs", included: 100, price: { amount: 0.3 } },
		{ featureId: "traces", included: 100, price: { amount: 0.3 } },
		{ featureId: "metrics", included: 100, price: { amount: 0.3 } },
		{ featureId: "browser_sessions", included: 5_000, price: { amount: 0.002 } },
		{ featureId: "product_events", included: 1_000_000, price: { amount: 0.005, billingUnits: 1_000 } },
	],
} as CatalogPlan

const customer = {
	id: "cus_1",
	subscriptions: [{ planId: "startup", status: "active", addOn: false }],
	billingControls: {
		spendLimits: [{ featureId: "logs", enabled: true, limitType: "absolute", overageLimit: 200 }],
	},
} as BillingCustomer

const model = buildSpendModel({
	customer,
	plans: [startup],
	usage: { logs: { sum: 164 }, traces: { sum: 131 } } as BillingUsage["total"],
	nowMs: Date.UTC(2026, 9, 17),
})

function Harness({ canEdit }: { canEdit: boolean }) {
	const [editing, setEditing] = useState<SpendFeatureId | null>(null)
	if (model === null) return null
	return (
		<BillingUsageTable
			model={model}
			customer={customer}
			canEdit={canEdit}
			editing={editing}
			onEditingChange={setEditing}
		/>
	)
}

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

describe("BillingUsageTable", () => {
	it("shows the cap and where usage stops", () => {
		render(<Harness canEdit />)

		expect(screen.getByText("+200.00 GB")).toBeTruthy()
		expect(screen.getByText("Stops at 300.00 GB")).toBeTruthy()
	})

	it("saves a cap typed inline as a single-feature update, then closes the editor", async () => {
		saveCaps.mockResolvedValue(Exit.succeed(new BillingControls({})))
		render(<Harness canEdit />)

		fireEvent.click(screen.getByRole("button", { name: "Edit Traces cap" }))
		fireEvent.change(screen.getByRole("spinbutton", { name: "Traces paid overage cap" }), {
			target: { value: "150" },
		})
		expect(screen.getByText("Paid overage. Stops at 250.00 GB")).toBeTruthy()
		fireEvent.click(screen.getByRole("button", { name: "Save" }))

		await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).toBeNull())
		expect(saveCaps).toHaveBeenCalledTimes(1)
		expect(saveCaps).toHaveBeenCalledWith(
			expect.objectContaining({
				payload: expect.objectContaining({
					spendLimits: [
						{ featureId: "traces", enabled: true, limitType: "absolute", overageLimit: 150 },
					],
				}),
			}),
		)
	})

	it("refuses a negative cap without calling the API", () => {
		render(<Harness canEdit />)

		fireEvent.click(screen.getByRole("button", { name: "Edit Logs cap" }))
		fireEvent.change(screen.getByRole("spinbutton", { name: "Logs paid overage cap" }), {
			target: { value: "-5" },
		})

		expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true)
		expect(saveCaps).not.toHaveBeenCalled()
	})

	it("offers no cap edits to members", () => {
		render(<Harness canEdit={false} />)

		expect(screen.queryByRole("button", { name: /Edit .* cap/ })).toBeNull()
	})
})
