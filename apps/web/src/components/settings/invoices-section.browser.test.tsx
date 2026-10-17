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
		// Six monthly invoices, newest first: September 2026 back to April.
		invoices: Array.from(
			{ length: 6 },
			(_, index) =>
				new BillingInvoice({
					status: "paid",
					total: 39,
					currency: "usd",
					createdAt: Date.UTC(2026, 8 - index, 1),
					hostedInvoiceUrl: `https://invoice.example/${index + 1}`,
				}),
		),
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
		const [newest] = screen.getAllByRole("link", { name: /^View invoice from / })
		expect(newest?.getAttribute("href")).toBe("https://invoice.example/1")
	})

	it("shows admins the four most recent invoices and the portal for the rest", () => {
		render(<InvoicesSection canManageBilling onManageBilling={() => {}} />)

		expect(screen.getAllByRole("link", { name: /^View invoice from / })).toHaveLength(4)
		expect(screen.getByRole("button", { name: "View all" })).toBeTruthy()
	})

	it("shows members every invoice, since the portal is admin-only", () => {
		render(<InvoicesSection canManageBilling={false} onManageBilling={() => {}} />)

		const links = screen.getAllByRole("link", { name: /^View invoice from / })
		expect(links.map((link) => link.getAttribute("href"))).toEqual(
			Array.from({ length: 6 }, (_, index) => `https://invoice.example/${index + 1}`),
		)
		expect(screen.queryByRole("button", { name: "View all" })).toBeNull()
	})
})
