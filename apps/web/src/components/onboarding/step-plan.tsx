import type { ReactNode } from "react"
import { useMapleCustomer } from "@/hooks/use-maple-customer"
import { TRIAL_DURATION_DAYS } from "@/lib/billing/plans"
import { PricingCards } from "@/components/settings/pricing-cards"
import { Button } from "@maple/ui/components/ui/button"
import { Panel } from "@maple/ui/components/ui/panel"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { ArrowLeftIcon } from "@/components/icons"

export function StepPlan({ onBack }: { onBack?: () => void }) {
	const { isLoading } = useMapleCustomer()

	return (
		<StepPlanLayout onBack={onBack}>{isLoading ? <PricingSkeleton /> : <PricingCards />}</StepPlanLayout>
	)
}

export function StepPlanLayout({ onBack, children }: { onBack?: () => void; children: ReactNode }) {
	return (
		<div className="flex-1 flex flex-col items-center px-6 py-12 overflow-auto">
			<div className="w-full max-w-5xl">
				<div className="text-center mb-10">
					<Eyebrow variant="label" className="text-primary">
						Pick a plan
					</Eyebrow>
					<h2 className="text-3xl font-semibold tracking-tight mt-2">Pick a plan to keep going</h2>
					<p className="text-muted-foreground text-sm mt-3 max-w-lg mx-auto">
						Start a {TRIAL_DURATION_DAYS}-day free trial: we'll save your card now and won't
						charge until day {TRIAL_DURATION_DAYS}. Cancel anytime from settings.
					</p>
				</div>

				{children}

				{onBack && (
					<div className="mt-8 flex items-center justify-start">
						<Button variant="ghost" onClick={onBack} className="gap-2">
							<ArrowLeftIcon />
							Back
						</Button>
					</div>
				)}
			</div>
		</div>
	)
}

function PricingSkeleton() {
	return (
		<div
			role="status"
			aria-label="Loading plans"
			className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-3xl mx-auto"
		>
			{[0, 1].map((i) => (
				<Panel key={`plan-skeleton-${i}`} className="gap-4 p-6">
					<Skeleton className="h-5 w-24" />
					<Skeleton className="h-8 w-32" />
					<div className="space-y-2 pt-2">
						<Skeleton className="h-3 w-full" />
						<Skeleton className="h-3 w-5/6" />
						<Skeleton className="h-3 w-4/6" />
						<Skeleton className="h-3 w-3/6" />
					</div>
					<Skeleton className="h-10 w-full rounded-md" />
				</Panel>
			))}
		</div>
	)
}
