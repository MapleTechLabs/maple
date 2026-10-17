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
	const [saving, setSaving] = useState(false)
	if (model === null) return null
	return (
		<>
			{/* Stands in for any path outside the table that opens a row, like "Set caps". */}
			<button type="button" onClick={() => setEditing("logs")}>
				Open logs from outside
			</button>
			<BillingUsageTable
				model={model}
				customer={customer}
				canEdit={canEdit}
				editing={editing}
				onEditingChange={setEditing}
				saving={saving}
				onSavingChange={setSaving}
			/>
		</>
	)
}

/** A save the test settles by hand. */
function deferredSave() {
	let resolve: (exit: Exit.Exit<BillingControls, never>) => void = () => {}
	const promise = new Promise<Exit.Exit<BillingControls, never>>((settle) => {
		resolve = settle
	})
	return { promise, resolve: (exit: Exit.Exit<BillingControls, never>) => resolve(exit) }
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

	it("reads an idle GB feature in the same unit as its allotment", () => {
		render(<Harness canEdit />)

		expect(screen.getByText("164.00 GB of 100.00 GB")).toBeTruthy()
		expect(screen.getByText("0.00 GB of 100.00 GB")).toBeTruthy()
	})

	it("saves a cap typed inline as a single-feature update, then closes the editor", async () => {
		saveCaps.mockResolvedValue(Exit.succeed(new BillingControls({})))
		render(<Harness canEdit />)

		fireEvent.click(screen.getByRole("button", { name: "Edit Traces cap" }))
		fireEvent.change(screen.getByRole("textbox", { name: "Traces paid overage cap" }), {
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

	it("keeps the editor open on Escape while a save is in flight", async () => {
		saveCaps.mockReturnValue(new Promise(() => {}))
		render(<Harness canEdit />)

		fireEvent.click(screen.getByRole("button", { name: "Edit Traces cap" }))
		const input = screen.getByRole("textbox", { name: "Traces paid overage cap" })
		fireEvent.change(input, { target: { value: "150" } })
		fireEvent.click(screen.getByRole("button", { name: "Save" }))
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true),
		)
		fireEvent.keyDown(input, { key: "Escape" })

		expect(screen.getByRole("textbox", { name: "Traces paid overage cap" })).toBeTruthy()
	})

	it("locks the other rows' Edit buttons while a save is in flight, then frees them", async () => {
		const pending = deferredSave()
		saveCaps.mockReturnValue(pending.promise)
		render(<Harness canEdit />)

		fireEvent.click(screen.getByRole("button", { name: "Edit Traces cap" }))
		fireEvent.change(screen.getByRole("textbox", { name: "Traces paid overage cap" }), {
			target: { value: "150" },
		})
		fireEvent.click(screen.getByRole("button", { name: "Save" }))
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Edit Logs cap" }).hasAttribute("disabled")).toBe(true),
		)

		pending.resolve(Exit.succeed(new BillingControls({})))
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Edit Logs cap" }).hasAttribute("disabled")).toBe(
				false,
			),
		)
	})

	it("does not close another row's editor when an earlier save lands", async () => {
		const pending = deferredSave()
		saveCaps.mockReturnValue(pending.promise)
		render(<Harness canEdit />)

		fireEvent.click(screen.getByRole("button", { name: "Edit Traces cap" }))
		fireEvent.change(screen.getByRole("textbox", { name: "Traces paid overage cap" }), {
			target: { value: "150" },
		})
		fireEvent.click(screen.getByRole("button", { name: "Save" }))
		fireEvent.click(screen.getByRole("button", { name: "Open logs from outside" }))
		pending.resolve(Exit.succeed(new BillingControls({})))

		// The save has settled once the other rows unlock.
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Edit Traces cap" }).hasAttribute("disabled")).toBe(
				false,
			),
		)
		expect(screen.getByRole("textbox", { name: "Logs paid overage cap" })).toBeTruthy()
	})

	it("sends one save when Enter is pressed again mid-save", async () => {
		saveCaps.mockReturnValue(new Promise(() => {}))
		render(<Harness canEdit />)

		fireEvent.click(screen.getByRole("button", { name: "Edit Traces cap" }))
		const input = screen.getByRole("textbox", { name: "Traces paid overage cap" })
		fireEvent.change(input, { target: { value: "150" } })
		fireEvent.keyDown(input, { key: "Enter" })
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true),
		)
		fireEvent.keyDown(input, { key: "Enter" })

		expect(saveCaps).toHaveBeenCalledTimes(1)
	})

	it("closes the editor on Escape when idle", () => {
		render(<Harness canEdit />)

		fireEvent.click(screen.getByRole("button", { name: "Edit Traces cap" }))
		fireEvent.keyDown(screen.getByRole("textbox", { name: "Traces paid overage cap" }), {
			key: "Escape",
		})

		expect(screen.queryByRole("textbox", { name: "Traces paid overage cap" })).toBeNull()
	})

	it("refuses a negative cap without calling the API", () => {
		render(<Harness canEdit />)

		fireEvent.click(screen.getByRole("button", { name: "Edit Logs cap" }))
		fireEvent.change(screen.getByRole("textbox", { name: "Logs paid overage cap" }), {
			target: { value: "-5" },
		})

		expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true)
		expect(saveCaps).not.toHaveBeenCalled()
	})

	it("refuses half-typed text instead of saving it as no cap", () => {
		render(<Harness canEdit />)

		fireEvent.click(screen.getByRole("button", { name: "Edit Logs cap" }))
		const input = screen.getByRole("textbox", { name: "Logs paid overage cap" })
		fireEvent.change(input, { target: { value: "1e" } })
		fireEvent.keyDown(input, { key: "Enter" })

		expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true)
		expect(screen.getByText("Enter zero or more, or leave empty for no cap.")).toBeTruthy()
		expect(saveCaps).not.toHaveBeenCalled()
	})

	it("offers no cap edits to members", () => {
		render(<Harness canEdit={false} />)

		expect(screen.queryByRole("button", { name: /Edit .* cap/ })).toBeNull()
	})
})
