import { useState } from "react"

import type { CatalogPlan } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogPanel,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { Panel } from "@maple/ui/components/ui/panel"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { ArrowRightIcon } from "@/components/icons"
import { sentenceCasePlanName } from "@/lib/billing/plans"
import type { SpendModel } from "@/lib/billing/spend"
import { SettingsSection } from "./settings-section"
import { PlanOffer } from "./plan-offer"

const ENTERPRISE_CALL_URL = "https://cal.com/david-granzin/30min?overlayCalendar=true"

function priceLabel(model: SpendModel): { price: string; suffix: string } {
	const plan = model.charges.find((charge) => charge.kind === "plan")
	// A hard-capped plan bills nothing past its allotments, so "+ usage" would be untrue.
	const billsUsage = model.features.some(
		(feature) => feature.overageAllowed !== false && feature.ratePerUnit !== null,
	)
	if (plan?.dollars == null) return { price: "Custom", suffix: "negotiated pricing" }
	const interval = `/${plan.interval ?? "month"}`
	return { price: `$${plan.dollars}`, suffix: billsUsage ? `${interval} + usage` : interval }
}

/** "Bring your own cloud ($99/month)": an add-on the plan could take, as plain text. */
const addOnLabel = (addOn: CatalogPlan): string => {
	const name = sentenceCasePlanName(addOn.name)
	return addOn.price?.amount == null
		? name
		: `${name} ($${addOn.price.amount}/${addOn.price.interval ?? "month"})`
}

function PlanRow({ model, plans }: { model: SpendModel; plans: ReadonlyArray<CatalogPlan> }) {
	if (model.planName === null) {
		return (
			<Panel padded>
				<p className="text-sm text-muted-foreground">No active plan. Compare plans to pick one.</p>
			</Panel>
		)
	}
	const { price, suffix } = priceLabel(model)
	const activeIds = new Set(model.addOns.map((addOn) => addOn.id))
	const available = plans.filter((plan) => plan.addOn === true && !activeIds.has(plan.id))

	return (
		<Panel className="flex-row flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3.5">
			<div className="flex items-baseline gap-3">
				<span className="text-sm font-medium">{sentenceCasePlanName(model.planName)}</span>
				<span className="flex items-baseline gap-0.5">
					<span className="font-mono text-sm tabular-nums">{price}</span>
					<span className="text-2xs text-muted-foreground">{suffix}</span>
				</span>
			</div>
			{(model.addOns.length > 0 || available.length > 0) && (
				<div className="flex flex-wrap items-center gap-1.5">
					{model.addOns.map((addOn) => (
						<Badge
							key={addOn.id ?? addOn.name}
							size="sm"
							pill
							className="bg-primary/15 text-primary"
						>
							{sentenceCasePlanName(addOn.name ?? "Add-on")}
						</Badge>
					))}
					{available.length > 0 && (
						<span className="text-2xs text-muted-foreground">
							Available add-ons: {available.map(addOnLabel).join(", ")}
						</span>
					)}
				</div>
			)}
		</Panel>
	)
}

/**
 * The current plan as one row, the full picker one click away, and Enterprise
 * as a single muted line. Members see the row without the picker.
 */
export function BillingPlanSection({
	model,
	plans,
	isLegacy,
	canManage,
}: {
	model: SpendModel | null
	plans: ReadonlyArray<CatalogPlan> | undefined
	isLegacy: boolean
	/** False for members and while a checkout is still confirming. */
	canManage: boolean
}) {
	const [comparing, setComparing] = useState(false)

	return (
		<SettingsSection
			title="Plan"
			description="Your plan and add-ons."
			framed={false}
			actions={
				canManage ? (
					<Button
						variant="link"
						size="sm"
						className="text-primary"
						onClick={() => setComparing(true)}
					>
						Compare plans
						<ArrowRightIcon aria-hidden className="size-3" />
					</Button>
				) : undefined
			}
		>
			{model === null || plans === undefined ? (
				<Skeleton className="h-12 w-full rounded-md" />
			) : (
				<PlanRow model={model} plans={plans} />
			)}
			{isLegacy && (
				<p className="px-1 text-xs text-muted-foreground">
					You're on a legacy plan that's no longer offered. Compare plans for current pricing and
					features.
				</p>
			)}
			<p className="px-1 text-xs text-muted-foreground">
				Enterprise adds higher volume, custom retention and priority support, from $2,000.{" "}
				<a
					href={ENTERPRISE_CALL_URL}
					target="_blank"
					rel="noopener noreferrer"
					className="font-medium whitespace-nowrap text-foreground underline underline-offset-4"
				>
					Talk to the founder
				</a>
			</p>

			{canManage && (
				<Dialog open={comparing} onOpenChange={setComparing}>
					<DialogContent className="max-w-4xl">
						<DialogHeader>
							<DialogTitle>Compare plans</DialogTitle>
							<DialogDescription>Plans and add-ons you can switch to.</DialogDescription>
						</DialogHeader>
						<DialogPanel>
							<PlanOffer model={model} />
						</DialogPanel>
					</DialogContent>
				</Dialog>
			)}
		</SettingsSection>
	)
}
