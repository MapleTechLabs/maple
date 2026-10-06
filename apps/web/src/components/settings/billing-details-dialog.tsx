import { useState } from "react"

import { BillingAddress, type BillingProfile, UpdateBillingProfileRequest } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { Field, FieldLabel } from "@maple/ui/components/ui/field"
import {
	Combobox,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
} from "@maple/ui/components/ui/combobox"
import {
	Dialog,
	DialogClose,
	DialogFooter,
	DialogHeader,
	DialogPopup,
	DialogTitle,
} from "@maple/ui/components/ui/dialog"
import { Input } from "@maple/ui/components/ui/input"

import { useMutationAction } from "@/hooks/use-mutation-action"
import { fieldOrNull } from "@/lib/billing/billing-profile"
import { countryName, sortedCountryCodes } from "@/lib/billing/countries"
import { BILLING_PROFILE_KEY, updateBillingProfileMutation } from "@/lib/services/atoms/billing-atoms"

const COUNTRIES = sortedCountryCodes()

/**
 * Company name + billing address, written straight to the Stripe customer.
 * Every field is optional — Stripe prints whatever is set — so an empty field
 * clears the line rather than being "invalid".
 */
export function BillingDetailsDialog({
	profile,
	open,
	onOpenChange,
}: {
	readonly profile: BillingProfile
	readonly open: boolean
	readonly onOpenChange: (open: boolean) => void
}) {
	const [save, saving] = useMutationAction(updateBillingProfileMutation, {
		success: "Billing details saved.",
		error: "Billing details could not be saved.",
		onSuccess: () => onOpenChange(false),
	})
	const address = profile.address
	const [name, setName] = useState(profile.name ?? "")
	const [line1, setLine1] = useState(address?.line1 ?? "")
	const [line2, setLine2] = useState(address?.line2 ?? "")
	const [city, setCity] = useState(address?.city ?? "")
	const [state, setState] = useState(address?.state ?? "")
	const [postalCode, setPostalCode] = useState(address?.postalCode ?? "")
	const [country, setCountry] = useState<string | null>(address?.country?.toUpperCase() ?? null)

	async function handleSave() {
		const fields = {
			line1: fieldOrNull(line1),
			line2: fieldOrNull(line2),
			city: fieldOrNull(city),
			state: fieldOrNull(state),
			postalCode: fieldOrNull(postalCode),
			country,
		}
		const anyAddress = Object.values(fields).some((value) => value !== null)

		await save({
			payload: new UpdateBillingProfileRequest({
				name: fieldOrNull(name),
				// All-empty clears the address outright; otherwise every line is sent
				// (null → cleared) so a removed line does not linger on the invoice.
				address: anyAddress ? new BillingAddress(fields) : null,
			}),
			reactivityKeys: [BILLING_PROFILE_KEY],
		})
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogPopup className="w-[480px] max-w-[calc(100vw-2rem)] gap-0 p-0">
				<DialogHeader className="px-5 pt-[18px] pb-0">
					<DialogTitle className="text-[17px] tracking-tight">Billing details</DialogTitle>
				</DialogHeader>

				<div className="space-y-4 px-5 pt-[18px]">
					<Field>
						<FieldLabel htmlFor="billing-name">Company name</FieldLabel>
						<Input
							id="billing-name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder="Legal entity as it should appear on invoices"
							maxLength={150}
							autoComplete="organization"
						/>
					</Field>

					<Field>
						<FieldLabel htmlFor="billing-line1">Address</FieldLabel>
						<Input
							id="billing-line1"
							value={line1}
							onChange={(event) => setLine1(event.target.value)}
							placeholder="Street and number"
							autoComplete="address-line1"
						/>
						<Input
							aria-label="Address line 2"
							value={line2}
							onChange={(event) => setLine2(event.target.value)}
							placeholder="Suite, floor, c/o (optional)"
							autoComplete="address-line2"
						/>
					</Field>

					<div className="grid grid-cols-[1fr_2fr] gap-2">
						<Field>
							<FieldLabel htmlFor="billing-postal">Postal code</FieldLabel>
							<Input
								id="billing-postal"
								value={postalCode}
								onChange={(event) => setPostalCode(event.target.value)}
								autoComplete="postal-code"
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="billing-city">City</FieldLabel>
							<Input
								id="billing-city"
								value={city}
								onChange={(event) => setCity(event.target.value)}
								autoComplete="address-level2"
							/>
						</Field>
					</div>

					<div className="grid grid-cols-2 gap-2">
						<Field>
							<FieldLabel htmlFor="billing-state">State / region</FieldLabel>
							<Input
								id="billing-state"
								value={state}
								onChange={(event) => setState(event.target.value)}
								placeholder="Optional"
								autoComplete="address-level1"
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="billing-country">Country</FieldLabel>
							<Combobox<string | null>
								items={COUNTRIES}
								itemToStringLabel={(code: string | null) => (code ? countryName(code) : "")}
								value={country}
								onValueChange={(next) => setCountry(typeof next === "string" ? next : null)}
							>
								<ComboboxInput
									id="billing-country"
									placeholder="Search countries…"
									className="h-8 w-full"
								/>
								<ComboboxContent>
									<ComboboxEmpty>No country found.</ComboboxEmpty>
									<ComboboxList className="max-h-64 overflow-y-auto">
										{(code: string) => (
											<ComboboxItem key={code} value={code}>
												{countryName(code)}
											</ComboboxItem>
										)}
									</ComboboxList>
								</ComboboxContent>
							</Combobox>
						</Field>
					</div>

					<p className="text-[11px] leading-4 text-muted-foreground">
						Stored on your Stripe customer and printed on every invoice from the next one on. Add
						your VAT or tax ID separately below the details.
					</p>
				</div>

				<DialogFooter className="px-5 pt-[18px] pb-5">
					<DialogClose render={<Button variant="outline" size="sm" />}>Cancel</DialogClose>
					<Button size="sm" onClick={handleSave} loading={saving}>
						Save details
					</Button>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	)
}
