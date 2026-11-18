import { assert, describe, it } from "@effect/vitest"
import { Schema, Array as Arr, String as Str } from "effect"
import { OrgId, StatusPageId } from "@maple/primitives"
import { customDomainOwnershipRecord, fitsOwnershipRecord } from "./custom-domain-ownership"

const org = Schema.decodeSync(OrgId)("org_status_pages")
const otherOrg = Schema.decodeSync(OrgId)("org_status_pages_other")
const page = Schema.decodeSync(StatusPageId)("11111111-1111-4111-8111-111111111111")
const otherPage = Schema.decodeSync(StatusPageId)("22222222-2222-4222-8222-222222222222")

describe("customDomainOwnershipRecord", () => {
	it("is a TXT record under the hostname, valued by the first 16 bytes of the claim's SHA-256", () => {
		// printf 'org_status_pages\n11111111-1111-4111-8111-111111111111\nstatus.acme.com' | shasum -a 256
		assert.deepStrictEqual(
			customDomainOwnershipRecord({ orgId: org, pageId: page, hostname: "status.acme.com" }),
			{
				type: "TXT",
				name: "_maple-challenge.status.acme.com",
				value: "maple-status-page=1c2ba8fdad86fbbe9cdd85449b0e85c6",
				purpose: "ownership",
			},
		)
	})

	it("differs by organization, by page and by hostname", () => {
		const base = { orgId: org, pageId: page, hostname: "status.acme.com" }
		const values = Arr.map(
			[
				base,
				{ ...base, orgId: otherOrg },
				{ ...base, pageId: otherPage },
				{ ...base, hostname: "status.acme.io" },
			],
			(claim) => customDomainOwnershipRecord(claim).value,
		)
		assert.strictEqual(new Set(values).size, values.length)
	})
})

describe("fitsOwnershipRecord", () => {
	it("refuses a hostname whose ownership record name would pass the DNS limit", () => {
		assert.isTrue(fitsOwnershipRecord("status.acme.com"))
		assert.isTrue(fitsOwnershipRecord(Str.repeat(236)("a")))
		assert.isFalse(fitsOwnershipRecord(Str.repeat(237)("a")))
	})
})
