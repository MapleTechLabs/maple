import { formatCurrency } from "@maple/domain/format"
import type { BillingInvoice, CatalogPlan } from "@maple/domain/http"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { formatAddressLines } from "@maple/web/lib/billing/billing-profile"
import { planDisplayName } from "@maple/web/lib/billing/plans"
import { formatDateInTimezone } from "@maple/web-data/lib/timezone-format"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { badge } from "../../../ui/display"
import { emptyMessage } from "../../../ui/empty"
import { icon } from "../../../ui/icon"
import { keyValue, keyValueList } from "../../../ui/key-value"
import { panel } from "../../../ui/panel"
import { skeleton, skeletonList } from "../../../ui/skeleton"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { settingsSection } from "../kit/section"
import { taxIdValue, view as detailsDialogView } from "./details/view"
import { Message, type Model } from "./model"

type H = HtmlBuilder<Message>

// `InvoicesSection` and `BillingDetailsSection` (apps/web/src/components/settings/).

/** The compact list's length for admins; the rest live behind "View all" (the portal). */
const RECENT_INVOICES = 4

/** Stripe invoice statuses as badges; an unknown status shows its raw text. */
const statusBadge = (status: string) => {
	switch (status.toLowerCase()) {
		case "paid":
			return { label: "Paid", variant: "ok" } as const
		case "open":
			return { label: "Due", variant: "warn" } as const
		case "uncollectible":
		case "past_due":
			return { label: "Past due", variant: "crit" } as const
		case "draft":
			return { label: "Draft", variant: "secondary" } as const
		case "void":
			return { label: "Void", variant: "secondary" } as const
		default:
			return { label: status, variant: "secondary" } as const
	}
}

const planLabel = (invoice: BillingInvoice, catalog: ReadonlyArray<CatalogPlan>): string => {
	const ids = invoice.planIds ?? []
	return ids.length === 0 ? EMPTY_VALUE : ids.map((id) => planDisplayName(id, catalog)).join(" + ")
}

const INVOICE_COLUMNS = ["Date", "Plan", "Status", "Amount", "Invoice link"] as const

const invoiceRow = (h: H, invoice: BillingInvoice, timeZone: string, catalog: ReadonlyArray<CatalogPlan>, index: number): Html => {
	const status = statusBadge(invoice.status)
	const date = formatDateInTimezone(invoice.createdAt, { timeZone })
	return tableRow(
		h,
		[
			tableCell(h, [date], "w-32 whitespace-nowrap tabular-nums"),
			tableCell(h, [planLabel(invoice, catalog)], "max-w-0 truncate text-muted-foreground"),
			tableCell(h, [badge(h, { size: "sm", variant: status.variant }, [status.label])], "w-24"),
			tableCell(h, [formatCurrency(invoice.total, invoice.currency)], "w-24 text-right tabular-nums"),
			tableCell(
				h,
				invoice.hostedInvoiceUrl === undefined || invoice.hostedInvoiceUrl === null || invoice.hostedInvoiceUrl === ""
					? []
					: [
							h.a(
								[
									h.AriaLabel(`View invoice from ${date}`),
									h.Class("text-primary text-xs font-medium hover:underline"),
									h.Href(invoice.hostedInvoiceUrl),
									h.Rel("noopener noreferrer"),
									h.Target("_blank"),
								],
								["View"],
							),
						],
				"w-14 text-right",
			),
		],
		undefined,
		[h.Key(invoice.stripeId ?? `${invoice.createdAt}:${index}`)],
	)
}

const invoicesSkeleton = (h: H): Html =>
	skeletonList(h, {
		rows: 3,
		className: "gap-0 divide-y divide-border/60",
		renderRow: () =>
			h.div(
				[h.Class("flex items-center gap-4 py-2.5")],
				[skeleton(h, "h-3.5 w-24"), skeleton(h, "h-3.5 w-20 flex-1"), skeleton(h, "h-4 w-10"), skeleton(h, "h-3.5 w-14")],
			),
	})

/** Admins see the most recent few and "View all" opens the portal; members see every invoice. */
export const invoicesSection = (h: H, model: Model, timeZone: string): Html => {
	const catalog = AsyncData.getOrElse(model.plans, () => [])
	const invoices = [...AsyncData.getOrElse(model.invoices, () => [])].sort((a, b) => b.createdAt - a.createdAt)
	const visible = model.isAdmin ? invoices.slice(0, RECENT_INVOICES) : invoices
	const body = AsyncData.matchDataSplitEmpty(model.invoices, {
		onIdle: () => invoicesSkeleton(h),
		onLoading: () => invoicesSkeleton(h),
		onFailure: () =>
			h.div(
				[h.Class("flex items-center justify-between gap-4")],
				[
					h.p(
						[h.Class("text-muted-foreground text-sm")],
						[
							model.isAdmin
								? "Couldn't load invoices. You can still view them in the billing portal."
								: "Couldn't load invoices. An org admin can view them in the billing portal.",
						],
					),
					...(model.isAdmin
						? [
								button(
									h,
									{ variant: "outline", size: "sm", attributes: [h.OnClick(Message.ClickedManageBilling())] },
									["View invoices"],
								),
							]
						: []),
				],
			),
		onData: () =>
			invoices.length === 0
				? emptyMessage(h, { dashed: true }, ["Your first invoice appears after your first billing cycle closes."])
				: panel(h, {}, [
						table(h, {}, [
							// The rows read without labels, so the headers exist for assistive tech only.
							tableHeader(
								h,
								[
									tableRow(
										h,
										INVOICE_COLUMNS.map((column) =>
											tableHead(h, [h.span([h.Class("sr-only")], [column])], "h-0 p-0", [h.Key(column)]),
										),
									),
								],
								{ className: "[&_tr]:border-0" },
							),
							tableBody(h, visible.map((invoice, index) => invoiceRow(h, invoice, timeZone, catalog, index))),
						]),
					]),
	})
	return settingsSection(
		h,
		{
			id: "settings-billing-invoices",
			title: "Invoices",
			framed: false,
			...(model.isAdmin &&
				invoices.length > 0 && {
					actions: button(
						h,
						{
							variant: "link",
							size: "sm",
							className: "text-primary",
							attributes: [h.OnClick(Message.ClickedManageBilling())],
						},
						["View all", icon(h, "ArrowRightIcon", { className: "size-3", attributes: [h.AriaHidden(true)] })],
					),
				}),
		},
		[body],
	)
}

const ROW = "py-2.5 px-4 text-sm"

const muted = (h: H, text: string): Html => h.span([h.Class("text-muted-foreground/70")], [text])

const detailsSkeleton = (h: H): Html =>
	panel(
		h,
		{},
		[0, 1, 2].map((index) =>
			h.div(
				[h.Key(String(index)), h.Class("flex gap-8 border-b px-4 py-3 last:border-b-0")],
				[skeleton(h, "h-3.5 w-16"), skeleton(h, "h-3.5 w-56")],
			),
		),
	)

/** Company name, address and tax IDs as they print on the invoice; edited behind "Edit". */
export const detailsSection = (h: H, model: Model): Html => {
	const profile = AsyncData.getOrElse(model.profile, () => null)
	const body = AsyncData.matchDataSplitEmpty(model.profile, {
		onIdle: () => detailsSkeleton(h),
		onLoading: () => detailsSkeleton(h),
		onFailure: (failure) =>
			panel(h, { padded: true }, [
				h.p(
					[h.Class("text-sm text-muted-foreground")],
					[
						failure.isNotConfigured
							? "Billing details aren't set up for this deployment. Company name, address and tax IDs are managed in the billing portal instead."
							: "Billing details aren't available right now. Try again in a moment; your invoices still carry the details already on file.",
					],
				),
			]),
		onData: (details) => {
			const address = formatAddressLines(details.address).join(", ")
			return panel(h, {}, [
				keyValueList(h, { layout: "grid", className: "gap-x-8 gap-y-0 divide-y divide-border/60 text-sm" }, [
					keyValue(h, { label: "Bill to", className: ROW }, [
						details.name !== undefined && details.name !== null && details.name !== ""
							? details.name
							: muted(h, "No company name"),
					]),
					keyValue(h, { label: "Address", className: ROW, wrap: true }, [
						address === "" ? muted(h, "No billing address") : address,
					]),
					keyValue(h, { label: "Tax ID", className: ROW, wrap: true }, [
						details.taxIds.length === 0
							? muted(h, details.linked ? "None on file" : "Available once your organization has a plan")
							: h.span([h.Class("flex flex-col gap-1")], details.taxIds.map((taxId) => taxIdValue(h, taxId))),
					]),
				]),
			])
		},
	})
	return settingsSection(
		h,
		{
			id: "settings-billing-details",
			title: "Billing details",
			description: ["Printed on every invoice."],
			framed: false,
			...(model.isAdmin &&
				profile !== null && {
					actions: button(h, { variant: "outline", size: "sm", attributes: [h.OnClick(Message.ClickedEditDetails())] }, [
						"Edit",
					]),
				}),
		},
		[
			body,
			...(profile === null
				? []
				: [
						h.submodel({
							slotId: "billing-details-dialog",
							model: model.details,
							view: detailsDialogView,
							toParentMessage: (message) => Message.GotDetailsMessage({ message }),
							viewInputs: { profile },
						}),
					]),
		],
	)
}
