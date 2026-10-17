// TEST-SEAM: the invoice and plan atoms are process-global wiring with no
// instance-level injection seam, so their reads are replaced at the module boundary.
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BillingInvoice, BillingInvoicesResponse } from "@maple/domain/http"

const { invoicesAtom, plansAtom } = vi.hoisted(() => ({
	invoicesAtom: { name: "invoices" },
	plansAtom: { name: "plans" },
}))

vi.mock("@/lib/services/atoms/billing-atoms", () => ({
	billingInvoicesAtom: invoicesAtom,
	billingPlansAtom: plansAtom,
}))
vi.mock("@/hooks/use-timezone-preference", () => ({
	useTimezonePreference: () => ({ effectiveTimezone: "UTC" }),
}))
vi.mock("@/lib/effect-atom", async () => {
	const actual = await vi.importActual<typeof import("@/lib/effect-atom")>("@/lib/effect-atom")
	const invoices = new BillingInvoicesResponse({
		invoices: [
			new BillingInvoice({
				status: "paid",
				total: 39,
				currency: "usd",
				createdAt: Date.UTC(2026, 8, 1),
				hostedInvoiceUrl: "https://invoice.example/1",
			}),
		],
	})
	return {
		...actual,
		useAtomValue: (atom: unknown) =>
			atom === invoicesAtom ? actual.Result.success(invoices) : actual.Result.success({ plans: [] }),
	}
})

import { InvoicesSection } from "./invoices-section"

afterEach(cleanup)

describe("InvoicesSection", () => {
	it("labels every column and names each invoice link by its date", () => {
		render(<InvoicesSection canManageBilling onManageBilling={() => {}} />)

		const headers = screen.getAllByRole("columnheader").map((header) => header.textContent)
		expect(headers).toEqual(["Date", "Plan", "Status", "Amount", "Invoice link"])
		const link = screen.getByRole("link", { name: /^View invoice from / })
		expect(link.getAttribute("href")).toBe("https://invoice.example/1")
	})
})
