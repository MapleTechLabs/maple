import { describe, expect, it } from "vitest"
import { parseAuditLogSearch, linkedAuditEntryId } from "../settings/kit/audit-log-filters"
import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import { Option } from "effect"
import { fromString } from "foldkit/url"
import { urlToAppRoute } from "../../route"
import { auditEntryHref } from "./audit-entry-link"

const ENTRY_UUID = "9d2c1e3a-6a1b-4f0e-9c1d-2b3a4c5d6e7f"
const ENTRY = encodePublicId(PublicIdPrefixes.auditLogEntry, ENTRY_UUID)
const AT = Date.UTC(2026, 10, 12, 13, 57, 40, 412)

describe("auditEntryHref", () => {
	// The Settings audit log has no lookup by entry id: the link finds an old entry only because
	// its window ends on the entry and reads and changes are both shown.
	it("opens the Settings audit log on the minute that ends at the entry, with the entry named", () => {
		const route = urlToAppRoute(
			Option.getOrThrow(fromString(`http://maple.test${auditEntryHref(AT, ENTRY)}`)),
		)
		const search = route._tag === "Settings" ? route.search : {}
		const filters = parseAuditLogSearch(search)

		expect(route._tag).toBe("Settings")
		expect(linkedAuditEntryId(search)).toBe(ENTRY_UUID)
		expect(filters.kind).toBe("all")
		expect(filters.range).toMatchObject({ kind: "custom" })
		expect(
			filters.range.kind === "custom"
				? [Date.parse(filters.range.since ?? ""), Date.parse(filters.range.until ?? "")]
				: [],
		).toEqual([AT - 60_000, AT])
	})
})
