import type { BillingAddress } from "@maple/domain/http"
import { countryName } from "./countries"
import { Array as Arr, String as Str } from "effect"

/**
 * Pure helpers behind the billing-details card. The verification vocabulary
 * is Stripe's; an unknown status renders nothing rather than guessing.
 */

export type VerificationBadge = {
	readonly label: string
	readonly variant: "ok" | "warn" | "secondary"
}

/** Badge copy for a Stripe tax-id verification status, or null when there is nothing worth saying. */
export const verificationBadge = (status: string | null | undefined): VerificationBadge | null => {
	switch (status) {
		case "verified":
			return { label: "Verified", variant: "ok" }
		case "pending":
			return { label: "Verifying…", variant: "secondary" }
		case "unverified":
			return { label: "Not verified", variant: "warn" }
		default:
			// `unavailable` (no registry to check against) and anything Stripe adds
			// later: the id still prints on the invoice, so no badge.
			return null
	}
}

const present = (value: string | null | undefined): value is string =>
	typeof value === "string" && Str.trim(value).length > 0

/**
 * The address as invoice lines: street lines, then "postal code city, state",
 * then the country name. Empty when nothing is set.
 */
export const formatAddressLines = (address: BillingAddress | null | undefined): ReadonlyArray<string> => {
	if (!address) return []
	const lines: string[] = []
	if (present(address.line1)) lines.push(Str.trim(address.line1))
	if (present(address.line2)) lines.push(Str.trim(address.line2))
	const locality = Arr.join(
		Arr.map(Arr.filter([address.postalCode, address.city], present), (part) => Str.trim(part)),
		" ",
	)
	const region = present(address.state) ? Str.trim(address.state) : ""
	const localityLine = Arr.join(
		Arr.filter([locality, region], (part) => part.length > 0),
		", ",
	)
	if (localityLine.length > 0) lines.push(localityLine)
	if (present(address.country)) lines.push(countryName(Str.toUpperCase(Str.trim(address.country))))
	return lines
}

/** Does the address carry anything at all? */
export const hasAddress = (address: BillingAddress | null | undefined): boolean =>
	formatAddressLines(address).length > 0

/** Trim an input field; an empty field becomes `null` so Stripe clears it. */
export const fieldOrNull = (value: string): string | null => {
	const trimmed = Str.trim(value)
	return trimmed.length === 0 ? null : trimmed
}
