import { useState } from "react"
import { Cause, Schema } from "effect"

import { BillingNotConfiguredError } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { KeyValue, KeyValueList } from "@maple/ui/components/ui/key-value"
import { Panel } from "@maple/ui/components/ui/panel"
import { Skeleton } from "@maple/ui/components/ui/skeleton"

import { Result, useAtomValue } from "@/lib/effect-atom"
import { formatAddressLines } from "@/lib/billing/billing-profile"
import { billingProfileAtom } from "@/lib/services/atoms/billing-atoms"
import { BillingDetailsDialog } from "./billing-details-dialog"
import { TaxIdValue } from "./billing-tax-ids-editor"
import { SettingsSection } from "./settings-section"

// A self-hosted API with no STRIPE_SECRET_KEY answers every profile read with
// this; that is a deployment choice, not an outage, and reads differently.
const isNotConfigured = Schema.is(BillingNotConfiguredError)

const ROW = "py-2.5 px-4 text-sm"

export function BillingDetailsSkeleton() {
	return (
		<Panel>
			{[0, 1, 2].map((index) => (
				<div key={index} className="flex gap-8 border-b px-4 py-3 last:border-b-0">
					<Skeleton className="h-3.5 w-16" />
					<Skeleton className="h-3.5 w-56" />
				</div>
			))}
		</Panel>
	)
}

const Muted = ({ children }: { children: string }) => (
	<span className="text-muted-foreground/70">{children}</span>
)

/**
 * Company name, address and tax IDs as they print on the invoice, read from the
 * Stripe customer behind the subscription. Everything is edited behind "Edit".
 */
export function BillingDetailsSection({ canEdit }: { readonly canEdit: boolean }) {
	const profileResult = useAtomValue(billingProfileAtom)
	const [editing, setEditing] = useState(false)
	const profile = Result.isSuccess(profileResult) ? profileResult.value : undefined

	return (
		<SettingsSection
			title="Billing details"
			description="Printed on every invoice."
			framed={false}
			actions={
				canEdit && profile !== undefined ? (
					<Button variant="outline" size="sm" onClick={() => setEditing(true)}>
						Edit
					</Button>
				) : undefined
			}
		>
			{Result.isInitial(profileResult) ? (
				<BillingDetailsSkeleton />
			) : profile === undefined ? (
				<Panel padded>
					<p className="text-sm text-muted-foreground">
						{Result.isFailure(profileResult) && isNotConfigured(Cause.squash(profileResult.cause))
							? "Billing details aren't set up for this deployment. Company name, address and tax IDs are managed in the billing portal instead."
							: "Billing details aren't available right now. Try again in a moment; your invoices still carry the details already on file."}
					</p>
				</Panel>
			) : (
				<Panel>
					<KeyValueList layout="grid" className="gap-x-8 gap-y-0 divide-y divide-border/60 text-sm">
						<KeyValue label="Bill to" className={ROW}>
							{profile.name ? profile.name : <Muted>No company name</Muted>}
						</KeyValue>
						<KeyValue label="Address" className={ROW} wrap>
							{formatAddressLines(profile.address).join(", ") || (
								<Muted>No billing address</Muted>
							)}
						</KeyValue>
						<KeyValue label="Tax ID" className={ROW} wrap>
							{profile.taxIds.length === 0 ? (
								<Muted>
									{profile.linked
										? "None on file"
										: "Available once your organization has a plan"}
								</Muted>
							) : (
								<span className="flex flex-col gap-1">
									{profile.taxIds.map((taxId) => (
										<TaxIdValue key={taxId.id} taxId={taxId} />
									))}
								</span>
							)}
						</KeyValue>
					</KeyValueList>
				</Panel>
			)}

			{editing && profile !== undefined && (
				<BillingDetailsDialog profile={profile} open={editing} onOpenChange={setEditing} />
			)}
		</SettingsSection>
	)
}
