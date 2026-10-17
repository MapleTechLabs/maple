import { useState } from "react"

import { AddBillingTaxIdRequest, type BillingProfile, type BillingTaxId } from "@maple/domain/http"
import {
	TAX_ID_TYPES,
	defaultTaxIdTypeFor,
	isTaxIdType,
	taxIdExampleFor,
	taxIdLabel,
} from "@maple/domain/billing-tax-ids"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { ConfirmDialog } from "@maple/ui/components/ui/confirm-dialog"
import { Field, FieldError, FieldLabel } from "@maple/ui/components/ui/field"
import { IconButton } from "@maple/ui/components/ui/icon-button"
import { Input } from "@maple/ui/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"

import { XmarkIcon } from "@/components/icons"
import { useExclusiveAsyncAction, useKeyedAsyncAction } from "@/hooks/use-mutation-action"
import { verificationBadge } from "@/lib/billing/billing-profile"
import { toastExit } from "@/lib/error-toast"
import { useAtomSet } from "@/lib/effect-atom"
import {
	BILLING_PROFILE_KEY,
	addBillingTaxIdMutation,
	removeBillingTaxIdMutation,
} from "@/lib/services/atoms/billing-atoms"

// Type picker order: the handful most customers want, then everything else
// alphabetically by label. One flat list reads better than a grouped 100-entry select.
const FEATURED_TYPES: ReadonlyArray<string> = [
	"eu_vat",
	"gb_vat",
	"ch_vat",
	"us_ein",
	"ca_gst_hst",
	"au_abn",
	"in_gst",
]
const TYPE_OPTIONS = [
	...FEATURED_TYPES.flatMap((type) => TAX_ID_TYPES.filter((info) => info.type === type)),
	...TAX_ID_TYPES.filter((info) => !FEATURED_TYPES.includes(info.type)).sort((a, b) =>
		a.label.localeCompare(b.label),
	),
].map((info) => ({ value: info.type, label: info.label }))

/** A tax ID as it prints: value, type and Stripe's verification badge. */
export function TaxIdValue({ taxId }: { readonly taxId: BillingTaxId }) {
	const badge = verificationBadge(taxId.verificationStatus)
	return (
		<span className="flex min-w-0 items-center gap-3">
			<span className="font-mono tabular-nums">{taxId.value}</span>
			<span className="truncate text-muted-foreground">{taxIdLabel(taxId.type)}</span>
			{badge && (
				<Badge size="sm" variant={badge.variant}>
					{badge.label}
				</Badge>
			)}
		</span>
	)
}

function AddTaxIdRow({ profile }: { readonly profile: BillingProfile }) {
	const add = useAtomSet(addBillingTaxIdMutation, { mode: "promiseExit" })
	const [type, setType] = useState<string>(defaultTaxIdTypeFor(profile.address?.country) ?? "eu_vat")
	const [value, setValue] = useState("")
	const [missingValue, setMissingValue] = useState(false)

	// Exclusive: Enter can repeat before `adding` re-renders, and each call creates a tax ID.
	const [handleAdd, adding] = useExclusiveAsyncAction(async () => {
		const trimmed = value.trim()
		if (!isTaxIdType(type)) return
		if (trimmed.length === 0) {
			setMissingValue(true)
			return
		}
		const exit = await add({
			payload: new AddBillingTaxIdRequest({ type, value: trimmed }),
			reactivityKeys: [BILLING_PROFILE_KEY],
		})
		if (
			toastExit(exit, {
				success: "Tax ID added. Stripe is verifying it.",
				error: "The tax ID could not be added.",
			})
		) {
			setValue("")
		}
	})

	return (
		<Field invalid={missingValue} className="gap-1.5">
			<div className="flex flex-wrap items-center gap-2">
				<Select items={TYPE_OPTIONS} value={type} onValueChange={(next) => next && setType(next)}>
					<SelectTrigger aria-label="Tax ID type" size="sm" className="w-48">
						<SelectValue />
					</SelectTrigger>
					<SelectContent className="max-h-72">
						{TYPE_OPTIONS.map((option) => (
							<SelectItem key={option.value} value={option.value} className="text-xs">
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Input
					aria-label="Tax ID"
					value={value}
					onChange={(event) => {
						setValue(event.target.value)
						setMissingValue(false)
					}}
					onKeyDown={(event) => {
						// Inside the details form: Enter adds the ID instead of submitting the form.
						if (event.key !== "Enter") return
						event.preventDefault()
						void handleAdd()
					}}
					placeholder={taxIdExampleFor(type, profile.address?.country)}
					className="min-w-0 flex-1 font-mono"
				/>
				<Button
					type="button"
					size="sm"
					variant="outline"
					onClick={() => void handleAdd()}
					loading={adding}
				>
					Add
				</Button>
			</div>
			{missingValue ? <FieldError match>Enter the tax ID first.</FieldError> : null}
		</Field>
	)
}

/**
 * Tax IDs inside the billing details dialog. They save on add and remove, unlike
 * the name and address, because each one is its own Stripe object.
 */
export function BillingTaxIdsEditor({ profile }: { readonly profile: BillingProfile }) {
	const remove = useAtomSet(removeBillingTaxIdMutation, { mode: "promiseExit" })
	const [confirmRemove, setConfirmRemove] = useState<BillingTaxId | null>(null)
	const removal = useKeyedAsyncAction(async (_id: string, taxId: BillingTaxId) => {
		const exit = await remove({
			params: { taxIdId: taxId.id },
			reactivityKeys: [BILLING_PROFILE_KEY],
		})
		return toastExit(exit, {
			success: `Removed ${taxIdLabel(taxId.type)} ${taxId.value}`,
			error: "The tax ID could not be removed.",
		})
	})

	return (
		<Field className="gap-2">
			<FieldLabel>Tax IDs</FieldLabel>
			{!profile.linked ? (
				<p className="text-xs text-muted-foreground">Available once your organization has a plan.</p>
			) : (
				<>
					{profile.taxIds.length > 0 && (
						<ul className="divide-y divide-border/40 text-sm">
							{profile.taxIds.map((taxId) => (
								<li key={taxId.id} className="flex items-center gap-3 py-1.5">
									<TaxIdValue taxId={taxId} />
									<IconButton
										type="button"
										size="icon-xs"
										onClick={() => setConfirmRemove(taxId)}
										loading={removal.isPending(taxId.id)}
										label={`Remove ${taxIdLabel(taxId.type)} ${taxId.value}`}
										className="ml-auto text-muted-foreground"
									>
										<XmarkIcon />
									</IconButton>
								</li>
							))}
						</ul>
					)}
					<AddTaxIdRow key={profile.address?.country ?? "none"} profile={profile} />
					<p className="text-2xs leading-4 text-muted-foreground">
						Tax IDs save as you add or remove them. EU, UK and Australian numbers are checked
						against the official registry; the ID is printed on invoices either way.
					</p>
				</>
			)}

			<ConfirmDialog
				open={confirmRemove !== null}
				onOpenChange={(open) => (open ? undefined : setConfirmRemove(null))}
				title="Remove tax ID?"
				description={
					confirmRemove
						? `${taxIdLabel(confirmRemove.type)} ${confirmRemove.value} will no longer print on invoices.`
						: undefined
				}
				confirmLabel="Remove tax ID"
				onConfirm={() => (confirmRemove ? removal.run(confirmRemove.id, confirmRemove) : undefined)}
			/>
		</Field>
	)
}
