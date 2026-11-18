import { createHash } from "node:crypto"
import {
	CUSTOM_DOMAIN_CHALLENGE_LABEL,
	type StatusPageCustomDomainDnsRecord,
} from "@maple/domain/status-page"
import type { OrgId, StatusPageId } from "@maple/primitives"

/** The page and organization claiming a hostname. */
export interface CustomDomainClaim {
	readonly orgId: OrgId
	readonly pageId: StatusPageId
	readonly hostname: string
}

/** DNS caps a name at 253 characters; the ownership record's name has to fit too. */
const DNS_NAME_MAX_LENGTH = 253
/** How much of the digest the record carries: 128 bits, far past guessing. */
const CHALLENGE_BYTES = 16

/**
 * The TXT record that proves a claim. Its value comes from the organization, the page and the
 * hostname alone, so a record published for one claim never verifies another, and nothing is
 * stored: only whoever controls the zone can publish it under the hostname.
 */
export const customDomainOwnershipRecord = (claim: CustomDomainClaim): StatusPageCustomDomainDnsRecord => ({
	type: "TXT",
	name: `${CUSTOM_DOMAIN_CHALLENGE_LABEL}.${claim.hostname}`,
	value: `maple-status-page=${createHash("sha256")
		.update(`${claim.orgId}\n${claim.pageId}\n${claim.hostname}`, "utf8")
		.digest()
		.subarray(0, CHALLENGE_BYTES)
		.toString("hex")}`,
	purpose: "ownership",
})

/** True when the hostname leaves room for the ownership record's name under it. */
export const fitsOwnershipRecord = (hostname: string): boolean =>
	CUSTOM_DOMAIN_CHALLENGE_LABEL.length + 1 + hostname.length <= DNS_NAME_MAX_LENGTH
