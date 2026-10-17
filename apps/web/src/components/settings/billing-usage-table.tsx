import { useState, type Dispatch, type SetStateAction } from "react"

import type { BillingCustomer } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
	InputGroupText,
} from "@maple/ui/components/ui/input-group"
import { SegmentedBar } from "@maple/ui/components/ui/meter"
import { Panel } from "@maple/ui/components/ui/panel"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { cn } from "@maple/ui/lib/utils"

import { formatCurrency } from "@maple/domain/format"
import { useMutationAction } from "@/hooks/use-mutation-action"
import { capApplies, parseCapInput, spendLimitFor, updateFeatureControls } from "@/lib/billing/controls"
import {
	FEATURE_COLORS,
	featureUnit,
	rateCaption,
	SPEND_FEATURES,
	type FeatureSpend,
	type SpendFeatureId,
	type SpendModel,
	usageMeter,
} from "@/lib/billing/spend"
import { formatCount, formatUsageAgainst } from "@/lib/billing/usage"
import { BILLING_CUSTOMER_KEY, updateBillingControlsMutation } from "@/lib/services/atoms/billing-atoms"
import { formatFeatureUsage } from "./format-feature-usage"

/** A volume with its unit: "164.00 GB", "3,412 sessions". */
const withUnit = (featureId: string, value: number) =>
	featureUnit(featureId) === "GB"
		? formatFeatureUsage(featureId, value)
		: `${formatCount(value)} ${featureUnit(featureId)}`

/** "164.00 GB of 100.00 GB": usage against the allotment, or what stands in for one. */
function usageLine(feature: FeatureSpend): string {
	const used = withUnit(feature.featureId, feature.used)
	if (feature.unlimited) return `${used}, unlimited`
	if (feature.included === null) {
		// No allotment and no rate: the plan does not carry the feature at all.
		return feature.ratePerUnit === null ? `${used}, not on your plan` : `${used}, no allotment`
	}
	return featureUnit(feature.featureId) === "GB"
		? formatUsageAgainst(feature.used, feature.included)
		: `${formatCount(feature.used)} of ${withUnit(feature.featureId, feature.included)}`
}

export function BillingUsageTableSkeleton() {
	return (
		<Panel>
			{SPEND_FEATURES.map((featureId) => (
				<div key={featureId} className="flex items-center gap-4 border-b px-3 py-3 last:border-b-0">
					<Skeleton className="h-4 w-32" />
					<Skeleton className="h-1 flex-1" />
					<Skeleton className="h-4 w-16" />
					<Skeleton className="h-4 w-40" />
				</div>
			))}
		</Panel>
	)
}

function CapEditor({
	feature,
	existing,
	onDone,
	onSaved,
	onSavingChange,
}: {
	readonly feature: FeatureSpend
	readonly existing: number | undefined
	readonly onDone: () => void
	/** Runs after a successful save; may fire after the user moved on to another row. */
	readonly onSaved: () => void
	readonly onSavingChange: (saving: boolean) => void
}) {
	const [raw, setRaw] = useState(existing === undefined ? "" : String(existing))
	const [save, saving] = useMutationAction(updateBillingControlsMutation, {
		success: `${feature.label} cap saved`,
		error: "The overage cap could not be saved.",
		onSuccess: onSaved,
	})
	const parsed = parseCapInput(raw)

	const submit = () => {
		if (!parsed.valid || saving) return
		onSavingChange(true)
		void save({
			payload: updateFeatureControls({ featureId: feature.featureId, overageLimit: parsed.cap }),
			reactivityKeys: [BILLING_CUSTOMER_KEY],
		}).finally(() => onSavingChange(false))
	}

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-center gap-1.5">
				<InputGroup className="w-28">
					<InputGroupInput
						autoFocus
						aria-label={`${feature.label} paid overage cap`}
						// Text, not number: a number input reports unparseable text as "", which reads as "no cap".
						type="text"
						inputMode="decimal"
						value={raw}
						placeholder="No cap"
						onChange={(event) => setRaw(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") submit()
							// Cancel is disabled mid-save, so Escape must not close the editor either.
							if (event.key === "Escape" && !saving) onDone()
						}}
						controlClassName="font-mono tabular-nums"
					/>
					<InputGroupAddon align="inline-end">
						<InputGroupText>{featureUnit(feature.featureId)}</InputGroupText>
					</InputGroupAddon>
				</InputGroup>
				<Button size="sm" onClick={submit} loading={saving} disabled={!parsed.valid}>
					Save
				</Button>
				<Button size="sm" variant="ghost" onClick={onDone} disabled={saving}>
					Cancel
				</Button>
			</div>
			<p className={cn("text-2xs", parsed.valid ? "text-muted-foreground" : "text-destructive")}>
				{!parsed.valid
					? "Enter zero or more, or leave empty for no cap."
					: parsed.cap === null
						? "Empty removes the cap."
						: feature.included === null
							? "Paid overage."
							: `Paid overage. Stops at ${withUnit(feature.featureId, feature.included + parsed.cap)}`}
			</p>
		</div>
	)
}

/** The cap cell at rest: the cap and where usage stops, or why a cap does not apply. */
function CapSummary({ feature, cap }: { readonly feature: FeatureSpend; readonly cap: number | undefined }) {
	if (!capApplies(feature)) {
		const reason = feature.unlimited
			? "Unlimited"
			: feature.overageAllowed === false
				? "Hard cap at included"
				: "Not billed"
		return <span className="text-muted-foreground">{reason}</span>
	}
	if (cap === undefined) return <span className="text-muted-foreground">Uncapped</span>
	const reached = feature.overageUnits > 0 && feature.overageUnits >= cap
	return (
		<div className="flex min-w-0 flex-col">
			<span className="font-mono tabular-nums">
				{cap === 0 ? "No overage" : `+${withUnit(feature.featureId, cap)}`}
			</span>
			<span className={cn("text-2xs", reached ? "text-severity-error" : "text-muted-foreground")}>
				{reached
					? "Cap reached, new data rejected"
					: feature.included === null
						? "Paid overage"
						: `Stops at ${withUnit(feature.featureId, feature.included + cap)}`}
			</span>
		</div>
	)
}

/**
 * One row per billable feature: included vs overage, what the overage costs, and
 * the paid overage cap, edited inline. `editing` is controlled so "Set caps" in
 * the cycle panel can open a row.
 */
export function BillingUsageTable({
	model,
	customer,
	canEdit,
	editing,
	onEditingChange,
	saving,
	onSavingChange,
}: {
	readonly model: SpendModel
	readonly customer: BillingCustomer
	readonly canEdit: boolean
	readonly editing: SpendFeatureId | null
	readonly onEditingChange: Dispatch<SetStateAction<SpendFeatureId | null>>
	/** A cap save is in flight; other rows cannot open their editor until it settles. */
	readonly saving: boolean
	readonly onSavingChange: (saving: boolean) => void
}) {
	return (
		<Panel>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead className="w-44">Feature</TableHead>
						<TableHead>Usage</TableHead>
						<TableHead className="w-28 text-right">Overage</TableHead>
						<TableHead className="w-60">Overage cap</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{model.features.map((feature) => {
						const cap = spendLimitFor(customer, feature.featureId)?.overageLimit
						const hardCapped = feature.overageAllowed === false && !feature.unlimited
						const hasOverage = feature.overageUnits > 0 && !hardCapped
						const meter = usageMeter(feature)
						const isEditing = editing === feature.featureId

						return (
							<TableRow key={feature.featureId} className={cn(isEditing && "bg-muted/40")}>
								<TableCell>
									<div className="flex min-w-0 items-center gap-2">
										<span
											aria-hidden
											className="size-2 shrink-0 rounded-full"
											style={{ background: FEATURE_COLORS[feature.featureId] }}
										/>
										<span className="truncate">{feature.label}</span>
									</div>
								</TableCell>
								<TableCell>
									<div className="flex min-w-0 flex-col gap-1.5">
										<SegmentedBar
											className="h-1 w-full rounded-none bg-muted"
											total={100}
											segments={[
												{
													key: "included",
													value: meter.included,
													color: FEATURE_COLORS[feature.featureId],
												},
												{
													key: "overage",
													value: meter.overage,
													className: "bg-primary",
												},
											]}
										/>
										<span className="truncate font-mono text-2xs tabular-nums text-muted-foreground">
											{usageLine(feature)}
										</span>
									</div>
								</TableCell>
								<TableCell className="text-right">
									<div className="flex flex-col items-end">
										<span
											className={cn(
												"font-mono tabular-nums",
												!hasOverage && "text-muted-foreground",
											)}
										>
											{hardCapped && feature.overageUnits > 0
												? "Rejected"
												: formatCurrency(feature.overageCents / 100, model.currency)}
										</span>
										<span className="font-mono text-2xs tabular-nums text-muted-foreground">
											{rateCaption(feature)}
										</span>
									</div>
								</TableCell>
								<TableCell>
									{isEditing ? (
										<CapEditor
											feature={feature}
											existing={cap}
											onDone={() => onEditingChange(null)}
											onSaved={() =>
												onEditingChange((current) =>
													current === feature.featureId ? null : current,
												)
											}
											onSavingChange={onSavingChange}
										/>
									) : (
										<div className="flex items-center justify-between gap-2">
											<CapSummary feature={feature} cap={cap} />
											{canEdit && capApplies(feature) && (
												<Button
													size="sm"
													variant="ghost"
													aria-label={`Edit ${feature.label} cap`}
													disabled={saving}
													onClick={() => onEditingChange(feature.featureId)}
												>
													Edit
												</Button>
											)}
										</div>
									)}
								</TableCell>
							</TableRow>
						)
					})}
				</TableBody>
			</Table>
		</Panel>
	)
}
