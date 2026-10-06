import { useState } from "react"

import type { BillingCustomer } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { Panel } from "@maple/ui/components/ui/panel"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"

import { maximumInvoiceCents, spendLimitFor } from "@/lib/billing/controls"
import { formatCurrency } from "@maple/domain/format"
import {
	FEATURE_COLORS,
	FEATURE_LABELS,
	SPEND_FEATURES,
	type SpendFeatureId,
	type SpendModel,
} from "@/lib/billing/spend"
import { BillingControlsDialog } from "./billing-controls-dialog"
import { formatFeatureUsage } from "./format-feature-usage"

export function BillingControlsCardSkeleton() {
	return (
		<Panel>
			<div className="flex items-center justify-between px-4 py-3">
				<Skeleton className="h-4 w-64" />
				<Skeleton className="h-4 w-32" />
			</div>
			{SPEND_FEATURES.map((featureId) => (
				<div key={featureId} className="border-t px-4 py-3">
					<Skeleton className="h-4 w-full max-w-lg" />
				</div>
			))}
		</Panel>
	)
}

export function BillingControlsCard({
	customer,
	model,
	canEdit,
}: {
	readonly customer: BillingCustomer
	readonly model: SpendModel | null
	readonly canEdit: boolean
}) {
	const [editing, setEditing] = useState<SpendFeatureId | null>(null)
	const maximum = maximumInvoiceCents(model, customer)

	return (
		<>
			<Panel>
				<div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
					<p className="max-w-[70ch] text-xs leading-5 text-muted-foreground">
						Each cap limits paid overage for one feature. Included usage is unaffected; the cap is
						enforced while usage keeps being recorded.
					</p>
					<p className="font-mono text-xs tabular-nums">
						Maximum invoice:{" "}
						{maximum === null ? "Uncapped" : formatCurrency(maximum / 100, "usd")}
					</p>
				</div>

				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Feature</TableHead>
							<TableHead>Paid overage cap</TableHead>
							<TableHead className="w-16">
								<span className="sr-only">Actions</span>
							</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{SPEND_FEATURES.map((featureId) => {
							const feature = model?.features.find((entry) => entry.featureId === featureId)
							const limit = spendLimitFor(customer, featureId)?.overageLimit
							const stopAt =
								limit === undefined || feature?.included == null
									? null
									: feature.included + limit

							return (
								<TableRow key={featureId}>
									<TableCell>
										<div className="flex min-w-0 items-center gap-2">
											<span
												aria-hidden
												className="size-2 shrink-0 rounded-xs"
												style={{ background: FEATURE_COLORS[featureId] }}
											/>
											<span className="truncate">{FEATURE_LABELS[featureId]}</span>
										</div>
									</TableCell>
									<TableCell>
										<p className="font-mono tabular-nums">
											{limit === undefined
												? "Paid overage uncapped"
												: `${formatFeatureUsage(featureId, limit)} paid overage`}
										</p>
										<p className="text-2xs text-muted-foreground">
											{stopAt === null
												? "No enforced stop this cycle"
												: `Stops at ${formatFeatureUsage(featureId, stopAt)} total usage`}
										</p>
									</TableCell>
									<TableCell className="text-right">
										<Button
											variant="outline"
											size="sm"
											onClick={() => setEditing(featureId)}
											disabled={!canEdit}
										>
											Edit
										</Button>
									</TableCell>
								</TableRow>
							)
						})}
					</TableBody>
				</Table>
			</Panel>
			{editing !== null && (
				<BillingControlsDialog
					key={editing}
					feature={model?.features.find((entry) => entry.featureId === editing) ?? null}
					featureId={editing}
					existingLimit={spendLimitFor(customer, editing)?.overageLimit}
					open
					onOpenChange={(next) => {
						if (!next) setEditing(null)
					}}
				/>
			)}
		</>
	)
}
