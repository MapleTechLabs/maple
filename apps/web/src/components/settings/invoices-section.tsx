import { useMemo } from "react"
import type { BillingInvoice } from "@maple/domain/http"

import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { EmptyMessage } from "@maple/ui/components/ui/empty"
import { Panel } from "@maple/ui/components/ui/panel"
import { Skeleton, SkeletonList } from "@maple/ui/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { EMPTY_VALUE } from "@maple/ui/lib/format"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatDateInTimezone } from "@/lib/timezone-format"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { billingInvoicesAtom } from "@/lib/services/atoms/billing-atoms"
import { formatCurrency } from "@maple/domain/format"

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

function planLabel(invoice: BillingInvoice): string {
	const ids = invoice.planIds ?? []
	if (ids.length === 0) return EMPTY_VALUE
	// planIds are catalog slugs ("startup"); capitalize for display.
	return ids.map((id) => id.charAt(0).toUpperCase() + id.slice(1)).join(" + ")
}

function InvoiceRow({ invoice, timeZone }: { invoice: BillingInvoice; timeZone: string }) {
	const badge = statusBadge(invoice.status)
	return (
		<TableRow>
			<TableCell className="whitespace-nowrap tabular-nums">
				{formatDateInTimezone(invoice.createdAt, { timeZone })}
			</TableCell>
			<TableCell className="max-w-0 truncate text-muted-foreground">{planLabel(invoice)}</TableCell>
			<TableCell>
				<Badge size="sm" variant={badge.variant}>
					{badge.label}
				</Badge>
			</TableCell>
			<TableCell className="text-right tabular-nums">
				{formatCurrency(invoice.total, invoice.currency)}
			</TableCell>
			<TableCell className="text-right">
				{invoice.hostedInvoiceUrl ? (
					<a
						href={invoice.hostedInvoiceUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="text-primary text-xs font-medium hover:underline"
					>
						View
					</a>
				) : null}
			</TableCell>
		</TableRow>
	)
}

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
 * Invoice history from Autumn/Stripe: date, plan, status, amount, and a link to
 * the Stripe-hosted invoice (view/PDF). Newest first. On upstream failure the
 * Stripe billing portal (via the provided handler) remains the escape hatch.
 */
export function InvoicesSection({ onManageBilling }: { onManageBilling: () => void }) {
	const invoicesResult = useAtomValue(billingInvoicesAtom)
	const { effectiveTimezone } = useTimezonePreference()

	const invoices = useMemo(() => {
		if (!Result.isSuccess(invoicesResult)) return []
		return [...invoicesResult.value.invoices].sort((a, b) => b.createdAt - a.createdAt)
	}, [invoicesResult])

	if (Result.isInitial(invoicesResult)) return <InvoicesSkeleton />

	if (!Result.isSuccess(invoicesResult)) {
		return (
			<div className="flex items-center justify-between gap-4">
				<p className="text-muted-foreground text-sm">
					Couldn't load invoices. You can still view them in the billing portal.
				</p>
				<Button variant="outline" size="sm" onClick={onManageBilling}>
					Open billing portal
				</Button>
			</div>
		)
	}

	if (invoices.length === 0) {
		return (
			<EmptyMessage dashed>
				Your first invoice appears after your first billing cycle closes.
			</EmptyMessage>
		)
	}

	return (
		<Panel>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead className="w-32">Date</TableHead>
						<TableHead>Plan</TableHead>
						<TableHead className="w-24">Status</TableHead>
						<TableHead className="w-24 text-right">Amount</TableHead>
						<TableHead className="w-14">
							<span className="sr-only">Invoice</span>
						</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{invoices.map((invoice, index) => (
						<InvoiceRow
							key={invoice.stripeId ?? `${invoice.createdAt}:${index}`}
							invoice={invoice}
							timeZone={effectiveTimezone}
						/>
					))}
				</TableBody>
			</Table>
		</Panel>
	)
}
