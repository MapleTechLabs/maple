import { formatCurrency } from "@maple/domain/format"
import type { BillingInvoice, CatalogPlan } from "@maple/domain/http"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { formatAddressLines } from "../../../lib/billing/billing-profile"
import { planDisplayName } from "../../../lib/billing/plans"
import { formatDateInTimezone } from "@maple/web-data/lib/timezone-format"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertAction, alertDescription, alertTitle } from "../../../ui/alert"
import { button, linkButton } from "../../../ui/button"
import { badge } from "../../../ui/display"
import { emptyMessage } from "../../../ui/empty"
import { icon } from "../../../ui/icon"
import { keyValue, keyValueList } from "../../../ui/key-value"
import { panel } from "../../../ui/panel"
import { skeleton, skeletonList } from "../../../ui/skeleton"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { errorState } from "../../../ui/error-state"
import { INLINE_LINK_CLASS, settingsSection } from "../kit/section"
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

/** Stripe statuses that still want paying: open, or overdue enough to be marked uncollectible. */
const isUnpaid = (invoice: BillingInvoice) =>
	["open", "past_due", "uncollectible"].includes(invoice.status.toLowerCase())

const hostedUrl = (invoice: BillingInvoice): string | null =>
	invoice.hostedInvoiceUrl === undefined ||
	invoice.hostedInvoiceUrl === null ||
	invoice.hostedInvoiceUrl === ""
		? null
		: invoice.hostedInvoiceUrl

const externalLink = (h: H, href: string) => [h.Href(href), h.Rel("noopener noreferrer"), h.Target("_blank")]

const planLabel = (invoice: BillingInvoice, catalog: ReadonlyArray<CatalogPlan>): string => {
	const ids = invoice.planIds ?? []
	return ids.length === 0 ? EMPTY_VALUE : ids.map((id) => planDisplayName(id, catalog)).join(" + ")
}

const INVOICE_COLUMNS = [
	{ label: "Date", className: "w-32" },
	{ label: "Plan", className: "" },
	{ label: "Status", className: "w-24" },
	{ label: "Amount", className: "w-28 text-right" },
	{ label: "Invoice", className: "w-20 text-right" },
] as const

const invoiceRow = (
	h: H,
	invoice: BillingInvoice,
	timeZone: string,
	catalog: ReadonlyArray<CatalogPlan>,
	index: number,
): Html => {
	const status = statusBadge(invoice.status)
	const date = formatDateInTimezone(invoice.createdAt, { timeZone })
	const url = hostedUrl(invoice)
	const unpaid = isUnpaid(invoice)
	return tableRow(
		h,
		[
			tableCell(h, [date], "w-32 whitespace-nowrap tabular-nums"),
			tableCell(h, [planLabel(invoice, catalog)], "max-w-0 truncate text-muted-foreground"),
			tableCell(h, [badge(h, { size: "sm", variant: status.variant }, [status.label])], "w-24"),
			tableCell(
				h,
				[formatCurrency(invoice.total, invoice.currency)],
				"w-28 text-right font-mono tabular-nums",
			),
			tableCell(
				h,
				url === null
					? []
					: [
							h.a(
								[
									h.AriaLabel(`${unpaid ? "Pay" : "View"} invoice from ${date}`),
									h.Class("text-primary text-xs font-medium hover:underline"),
									...externalLink(h, url),
								],
								[unpaid ? "Pay" : "View"],
							),
						],
				"w-20 text-right",
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
				[
					skeleton(h, "h-3.5 w-24"),
					skeleton(h, "h-3.5 w-20 flex-1"),
					skeleton(h, "h-4 w-10"),
					skeleton(h, "h-3.5 w-14"),
				],
			),
	})

/** Admins see the most recent few and "View all" opens the portal; members see every invoice. */
export const invoicesSection = (h: H, model: Model, timeZone: string): Html => {
	const catalog = AsyncData.getOrElse(model.plans, () => [])
	const invoices = [...AsyncData.getOrElse(model.invoices, () => [])].sort(
		(a, b) => b.createdAt - a.createdAt,
	)
	// Unpaid invoices always stay in the compact list, however old.
	const visible = model.isAdmin
		? invoices.filter((invoice, index) => index < RECENT_INVOICES || isUnpaid(invoice))
		: invoices
	const body = AsyncData.matchDataSplitEmpty(model.invoices, {
		onIdle: () => invoicesSkeleton(h),
		onLoading: () => invoicesSkeleton(h),
		onFailure: (failure) =>
			h.div(
				[h.Class("space-y-2")],
				[
					errorState(h, {
						variant: "row",
						failure,
						title: "Couldn't load invoices",
						onRetry: Message.ClickedRetryInvoices(),
					}),
					h.p(
						[h.Class("font-prose text-xs text-muted-foreground")],
						model.isAdmin
							? [
									"You can still view them in the ",
									button(
										h,
										{
											variant: "link",
											size: "xs",
											className: cn(
												"h-auto p-0 align-baseline text-xs",
												INLINE_LINK_CLASS,
											),
											attributes: [h.OnClick(Message.ClickedManageBilling())],
										},
										["billing portal"],
									),
									".",
								]
							: ["An org admin can view them in the billing portal."],
					),
				],
			),
		onData: () =>
			invoices.length === 0
				? emptyMessage(h, { dashed: true }, [
						"Your first invoice appears after your first billing cycle closes.",
					])
				: panel(h, {}, [
						table(h, {}, [
							tableHeader(h, [
								tableRow(
									h,
									INVOICE_COLUMNS.map((column) =>
										tableHead(
											h,
											[column.label],
											cn(
												"text-2xs font-medium text-muted-foreground",
												column.className,
											),
											[h.Key(column.label)],
										),
									),
								),
							]),
							tableBody(
								h,
								visible.map((invoice, index) =>
									invoiceRow(h, invoice, timeZone, catalog, index),
								),
							),
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
						[
							"View all",
							icon(h, "ArrowRightIcon", {
								className: "size-3",
								attributes: [h.AriaHidden(true)],
							}),
						],
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
			failure.isNotConfigured
				? panel(h, { padded: true }, [
						h.p(
							[h.Class("font-prose text-sm text-muted-foreground")],
							[
								"Billing details aren't set up for this deployment. Company name, address and tax IDs are managed in the billing portal instead.",
							],
						),
					])
				: errorState(h, {
						variant: "row",
						failure: failure.failure,
						title: "Couldn't load billing details",
						message: "Your invoices still carry the details already on file.",
						onRetry: Message.ClickedRetryProfile(),
					}),
		onData: (details) => {
			const address = formatAddressLines(details.address).join(", ")
			return panel(h, {}, [
				keyValueList(
					h,
					{ layout: "grid", className: "gap-x-8 gap-y-0 divide-y divide-border/60 text-sm" },
					[
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
								? muted(
										h,
										details.linked
											? "None on file"
											: "Available once your organization has a plan",
									)
								: h.span(
										[h.Class("flex flex-col gap-1")],
										details.taxIds.map((taxId) => taxIdValue(h, taxId)),
									),
						]),
					],
				),
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
					actions: button(
						h,
						{
							variant: "outline",
							size: "sm",
							attributes: [h.OnClick(Message.ClickedEditDetails())],
						},
						["Edit"],
					),
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

/** Above everything else on the tab: what is owed and a direct way to pay it on Stripe's invoice page. */
export const unpaidInvoicesNotice = (h: H, model: Model, timeZone: string): ReadonlyArray<Html> => {
	const unpaid = AsyncData.getOrElse(model.invoices, () => [])
		.filter(isUnpaid)
		.toSorted((a, b) => a.createdAt - b.createdAt)
	const oldest = unpaid[0]
	if (oldest === undefined) return []
	const overdue = unpaid.some((invoice) => invoice.status.toLowerCase() !== "open")
	const currencies = new Set(unpaid.map((invoice) => invoice.currency.toLowerCase()))
	const amount =
		currencies.size === 1
			? formatCurrency(
					unpaid.reduce((sum, invoice) => sum + invoice.total, 0),
					oldest.currency,
				)
			: null
	const title =
		unpaid.length === 1
			? `You have an unpaid invoice${amount === null ? "" : ` for ${amount}`}`
			: `You have ${unpaid.length} unpaid invoices${amount === null ? "" : ` totalling ${amount}`}`
	const since = formatDateInTimezone(oldest.createdAt, { timeZone })
	const url = hostedUrl(oldest)
	return [
		alert(h, { variant: overdue ? "crit" : "warn" }, [
			icon(h, "CircleWarningIcon"),
			alertTitle(h, [title]),
			alertDescription(h, [
				model.isAdmin
					? `${unpaid.length === 1 ? "Issued" : "The oldest was issued"} ${since}. Pay it with a card or bank transfer on the invoice page; it updates here once Stripe confirms the payment.`
					: `${unpaid.length === 1 ? "Issued" : "The oldest was issued"} ${since}. An org admin can pay it from this page.`,
			]),
			...(model.isAdmin
				? [
						alertAction(h, [
							url === null
								? button(
										h,
										{
											size: "sm",
											attributes: [h.OnClick(Message.ClickedManageBilling())],
										},
										["Pay in billing portal"],
									)
								: linkButton(
										h,
										{
											size: "sm",
											href: url,
											attributes: [h.Rel("noopener noreferrer"), h.Target("_blank")],
										},
										[unpaid.length === 1 ? "Pay invoice" : "Pay oldest invoice"],
									),
						]),
					]
				: []),
		]),
	]
}
