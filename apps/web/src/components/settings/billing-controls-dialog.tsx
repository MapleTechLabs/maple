import { useState } from "react"
import { Cause, Exit } from "effect"

import { Button } from "@maple/ui/components/ui/button"
import {
	Dialog,
	DialogClose,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@maple/ui/components/ui/field"
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
	InputGroupText,
} from "@maple/ui/components/ui/input-group"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { toastManager } from "@maple/ui/components/ui/toast"

import { useAtomSet } from "@/lib/effect-atom"
import { updateFeatureControls } from "@/lib/billing/controls"
import { formatCurrency } from "@/lib/billing/currency"
import {
	featureUnit,
	formatRateLabel,
	FEATURE_LABELS,
	type FeatureSpend,
	type SpendFeatureId,
} from "@/lib/billing/spend"
import { formatCount, formatUsage } from "@/lib/billing/usage"
import { BILLING_CUSTOMER_KEY, updateBillingControlsMutation } from "@/lib/services/atoms/billing-atoms"

const formatUnits = (featureId: SpendFeatureId, value: number) =>
	featureUnit(featureId) === "GB" ? formatUsage(value) : formatCount(value)

/** The typed cap, or null while the field is empty or not yet a usable number. */
const parseCap = (raw: string): number | null => {
	if (raw.trim() === "") return null
	const value = Number(raw)
	return Number.isFinite(value) && value >= 0 ? value : null
}

function SummaryRow({ label, value }: { readonly label: string; readonly value: string }) {
	return (
		<div className="flex items-baseline justify-between gap-4">
			<span className="text-xs text-muted-foreground">{label}</span>
			<span className="font-mono text-xs tabular-nums">{value}</span>
		</div>
	)
}

/**
 * What the cap costs, spelled out: the allowance it sits on top of, the rate it
 * bills at, and the ceiling it puts on the invoice. Rendered only when the plan
 * actually prices this feature — unlimited, hard-capped and unknown-rate
 * features have nothing truthful to say here.
 */
function CapSummary({
	feature,
	featureId,
	cap,
}: {
	readonly feature: FeatureSpend
	readonly featureId: SpendFeatureId
	readonly cap: number | null
}) {
	if (feature.unlimited || feature.overageAllowed === false || feature.ratePerUnit === null) return null
	const rate = formatRateLabel(feature)

	return (
		<div className="mt-5 space-y-2 rounded-lg border border-border/60 bg-muted/32 px-3 py-2.5">
			{feature.included !== null && (
				<SummaryRow label="Included this cycle" value={formatUnits(featureId, feature.included)} />
			)}
			{rate !== null && <SummaryRow label="Overage rate" value={rate} />}
			<SummaryRow
				label="Adds at most"
				value={
					cap === null
						? "Unlimited"
						: formatCurrency(Math.round(cap * feature.ratePerUnit * 100) / 100, "usd")
				}
			/>
			{cap !== null && feature.included !== null && (
				<SummaryRow label="Usage stops at" value={formatUnits(featureId, feature.included + cap)} />
			)}
		</div>
	)
}

export function BillingControlsDialog({
	feature,
	featureId,
	existingLimit,
	open,
	onOpenChange,
}: {
	readonly feature: FeatureSpend | null
	readonly featureId: SpendFeatureId
	readonly existingLimit: number | undefined
	readonly open: boolean
	readonly onOpenChange: (open: boolean) => void
}) {
	const save = useAtomSet(updateBillingControlsMutation, { mode: "promiseExit" })
	const [limit, setLimit] = useState(existingLimit === undefined ? "" : String(existingLimit))
	const [saving, setSaving] = useState(false)

	async function handleSave() {
		const overageLimit = limit.trim() === "" ? null : Number(limit)
		if (overageLimit !== null && (!Number.isFinite(overageLimit) || overageLimit < 0)) {
			toastManager.add({ title: "Paid overage cap must be zero or greater.", type: "error" })
			return
		}
		setSaving(true)
		const exit = await save({
			payload: updateFeatureControls({ featureId, overageLimit }),
			reactivityKeys: [BILLING_CUSTOMER_KEY],
		})
		setSaving(false)

		if (Exit.isSuccess(exit)) {
			toastManager.add({ title: `${FEATURE_LABELS[featureId]} controls saved.`, type: "success" })
			onOpenChange(false)
			return
		}
		const error = Cause.squash(exit.cause)
		toastManager.add({
			title: error instanceof Error ? error.message : "Billing controls could not be saved.",
			type: "error",
		})
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogPopup className="max-w-md">
				<DialogHeader>
					<DialogTitle>{FEATURE_LABELS[featureId]} billing controls</DialogTitle>
					<DialogDescription>
						Limit what {FEATURE_LABELS[featureId].toLowerCase()} can add to this cycle's invoice
						beyond the included allowance.
					</DialogDescription>
				</DialogHeader>

				<DialogPanel>
					<Field>
						<FieldLabel htmlFor="overage-limit">Paid overage cap</FieldLabel>
						<InputGroup>
							<InputGroupInput
								id="overage-limit"
								type="number"
								inputMode="decimal"
								min={0}
								step="any"
								value={limit}
								onChange={(event) => setLimit(event.target.value)}
								placeholder="No cap"
								// Spinners belong on a stepper, not on a cap you type once.
								controlClassName="font-mono tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:m-0 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
							/>
							<InputGroupAddon align="inline-end">
								<InputGroupText>{featureUnit(featureId)} / cycle</InputGroupText>
							</InputGroupAddon>
						</InputGroup>
						<FieldDescription>
							Usage is rejected once the included allowance plus this cap is consumed. Leave
							empty for uncapped overage.
						</FieldDescription>
					</Field>

					{feature !== null && (
						<CapSummary feature={feature} featureId={featureId} cap={parseCap(limit)} />
					)}
				</DialogPanel>

				<DialogFooter>
					<DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
					<Button onClick={handleSave} disabled={saving}>
						{saving ? <Spinner className="size-4" /> : "Save controls"}
					</Button>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	)
}
