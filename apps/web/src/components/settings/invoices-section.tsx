import { useMemo } from "react"
import type { BillingInvoice, CatalogPlan } from "@maple/domain/http"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { EmptyMessage } from "@maple/ui/components/ui/empty"
import { Panel } from "@maple/ui/components/ui/panel"
import { Skeleton, SkeletonList } from "@maple/ui/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { ArrowRightIcon } from "@/components/icons"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { planDisplayName } from "@/lib/billing/plans"
import { formatDateInTimezone } from "@/lib/timezone-format"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { billingInvoicesAtom, billingPlansAtom } from "@/lib/services/atoms/billing-atoms"
import { formatCurrency } from "@maple/domain/format"
import { SettingsSection } from "./settings-section"

/** The compact list's length for admins; the rest live behind "View all" (the portal). */
const RECENT_INVOICES = 4

// Stripe invoice statuses → badge treatment. Unknown statuses fall through to a
// plain secondary badge with the raw status text, never a crash.
function statusBadge(status: string) {
	switch (status.toLowerCase()) {
		case "paid":
			return { label: "Paid", variant: "ok" as const }
		case "open":
			return { label: "Due", variant: "warn" as const }
		case "uncollectible":
		case "past_due":
			return { label: "Past due", variant: "crit" as const }
		case "draft":
			return { label: "Draft", variant: "secondary" as const }
		case "void":
			return { label: "Void", variant: "secondary" as const }
		default:
			return { label: status, variant: "secondary" as const }
	}
}

function planLabel(invoice: BillingInvoice, catalog: ReadonlyArray<CatalogPlan>): string {
	const ids = invoice.planIds ?? []
	if (ids.length === 0) return EMPTY_VALUE
	// planIds are catalog slugs ("bringyourowncloud"): show the catalog's name.
	return ids.map((id) => planDisplayName(id, catalog)).join(" + ")
}

function InvoiceRow({
	invoice,
	timeZone,
	catalog,
}: {
	invoice: BillingInvoice
	timeZone: string
	catalog: ReadonlyArray<CatalogPlan>
}) {
	const badge = statusBadge(invoice.status)
	return (
		<TableRow>
			<TableCell className="w-32 whitespace-nowrap tabular-nums">
				{formatDateInTimezone(invoice.createdAt, { timeZone })}
			</TableCell>
			<TableCell className="max-w-0 truncate text-muted-foreground">
				{planLabel(invoice, catalog)}
			</TableCell>
			<TableCell className="w-24">
				<Badge size="sm" variant={badge.variant}>
					{badge.label}
				</Badge>
			</TableCell>
			<TableCell className="w-24 text-right tabular-nums">
				{formatCurrency(invoice.total, invoice.currency)}
			</TableCell>
			<TableCell className="w-14 text-right">
				{invoice.hostedInvoiceUrl ? (
					<a
						href={invoice.hostedInvoiceUrl}
						target="_blank"
						rel="noopener noreferrer"
						aria-label={`View invoice from ${formatDateInTimezone(invoice.createdAt, { timeZone })}`}
						className="text-primary text-xs font-medium hover:underline"
					>
						View
					</a>
				) : null}
			</TableCell>
		</TableRow>
	)
}

const INVOICE_COLUMNS = ["Date", "Plan", "Status", "Amount", "Invoice link"] as const

function InvoicesSkeleton() {
	return (
		<SkeletonList
			rows={3}
			className="gap-0 divide-y divide-border/60"
			renderRow={() => (
				<div className="flex items-center gap-4 py-2.5">
					<Skeleton className="h-3.5 w-24" />
					<Skeleton className="h-3.5 w-20 flex-1" />
					<Skeleton className="h-4 w-10" />
					<Skeleton className="h-3.5 w-14" />
				</div>
			)}
		/>
	)
}

/**
 * Invoices from Autumn/Stripe: date, plan, status, amount, and a link to the
 * Stripe-hosted invoice. Admins see the most recent few and "View all" opens the
 * billing portal; members, who cannot open the portal, see every invoice.
 */
export function InvoicesSection({
	canManageBilling,
	onManageBilling,
}: {
	/** The billing portal is admin-only server side. */
	canManageBilling: boolean
	onManageBilling: () => void
}) {
	const invoicesResult = useAtomValue(billingInvoicesAtom)
	const plansResult = useAtomValue(billingPlansAtom)
	const { effectiveTimezone } = useTimezonePreference()
	const catalog = Result.isSuccess(plansResult) ? plansResult.value.plans : []

	const invoices = useMemo(() => {
		if (!Result.isSuccess(invoicesResult)) return []
		return [...invoicesResult.value.invoices].sort((a, b) => b.createdAt - a.createdAt)
	}, [invoicesResult])

	// The portal is admin-only, so members get the full list in place of "View all".
	const visible = canManageBilling ? invoices.slice(0, RECENT_INVOICES) : invoices

	const viewAll =
		canManageBilling && invoices.length > 0 ? (
			<Button variant="link" size="sm" className="text-primary" onClick={onManageBilling}>
				View all
				<ArrowRightIcon aria-hidden className="size-3" />
			</Button>
		) : undefined

	return (
		<SettingsSection title="Invoices" framed={false} actions={viewAll}>
			{Result.isInitial(invoicesResult) ? (
				<InvoicesSkeleton />
			) : !Result.isSuccess(invoicesResult) ? (
				<div className="flex items-center justify-between gap-4">
					<p className="text-muted-foreground text-sm">
						{canManageBilling
							? "Couldn't load invoices. You can still view them in the billing portal."
							: "Couldn't load invoices. An org admin can view them in the billing portal."}
					</p>
					{canManageBilling && (
						<Button variant="outline" size="sm" onClick={onManageBilling}>
							View invoices
						</Button>
					)}
				</div>
			) : invoices.length === 0 ? (
				<EmptyMessage dashed>
					Your first invoice appears after your first billing cycle closes.
				</EmptyMessage>
			) : (
				<Panel>
					<Table>
						{/* The rows read without labels, so the headers exist for assistive tech only. */}
						<TableHeader className="[&_tr]:border-0">
							<TableRow>
								{INVOICE_COLUMNS.map((column) => (
									<TableHead key={column} className="h-0 p-0">
										<span className="sr-only">{column}</span>
									</TableHead>
								))}
							</TableRow>
						</TableHeader>
						<TableBody>
							{visible.map((invoice, index) => (
								<InvoiceRow
									key={invoice.stripeId ?? `${invoice.createdAt}:${index}`}
									invoice={invoice}
									timeZone={effectiveTimezone}
									catalog={catalog}
								/>
							))}
						</TableBody>
					</Table>
				</Panel>
			)}
		</SettingsSection>
	)
}
