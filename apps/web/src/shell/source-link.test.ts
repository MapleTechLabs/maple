import { encodePublicId, PublicIdPrefixes, V2Source } from "@maple/domain/http/v2"
import { Schema } from "effect"
import { describe, expect, test } from "vitest"
import { idSource, isResolved, platformSource, resolveSourceLink } from "./source-link"

const publicId = (n: number) =>
	encodePublicId(PublicIdPrefixes.source, `0199a0e1-0000-7000-8000-00000000000${n}`)

const source = (n: number, fields: Record<string, unknown> = {}) =>
	Schema.decodeUnknownSync(V2Source)({
		id: publicId(n),
		object: "source",
		name: `Source ${n}`,
		description: null,
		platform: "cloudflare",
		kind: "integration",
		is_default: false,
		key_prefix: null,
		integration_id: `int_${n}`,
		status: "active",
		allowed_signals: null,
		rate_limit_rps: null,
		resource_attributes: [],
		expires_at: null,
		paused_at: null,
		paused_until: null,
		last_used_at: null,
		rolled_at: null,
		created_at: "2026-10-01T00:00:00.000Z",
		updated_at: "2026-10-01T00:00:00.000Z",
		health: { status: "healthy", last_data_at: null, problem: null, resources: null },
		...fields,
	})

describe("resolveSourceLink", () => {
	test("an integration page with one source opens that source", () => {
		const link = resolveSourceLink(platformSource("cloudflare"), [
			source(1),
			source(2, { platform: "gcp" }),
		])
		expect(link).toMatchObject({ label: "Source 1", href: `/sources/${publicId(1)}` })
	})

	test("several sources of the platform open the Sources list", () => {
		const link = resolveSourceLink(platformSource("cloudflare"), [source(1), source(2)])
		expect(link).toMatchObject({ label: "2 Cloudflare sources", href: "/sources", source: null })
	})

	test("a platform with no source links nowhere", () => {
		expect(resolveSourceLink(platformSource("railway"), [source(1)])).toBeNull()
		expect(resolveSourceLink(platformSource("railway"), null)).toBeNull()
	})

	test("a stamped id links before the list answers and takes the name once it does", () => {
		const ref = idSource(publicId(3))
		expect(ref).not.toBeNull()
		if (ref === null) return
		expect(resolveSourceLink(ref, null)).toMatchObject({
			label: "Source",
			href: `/sources/${publicId(3)}`,
		})
		expect(resolveSourceLink(ref, [source(3, { platform: "host", kind: "token" })])).toMatchObject({
			label: "Source 3",
			href: `/sources/${publicId(3)}`,
		})
	})

	test("data sent before sources were stamped names no source", () => {
		expect(idSource("")).toBeNull()
	})
})

describe("isResolved", () => {
	test("a source the list lacks (just connected) is unresolved", () => {
		expect(isResolved(platformSource("gcp"), [source(1)])).toBe(false)
		expect(isResolved(platformSource("cloudflare"), [source(1)])).toBe(true)
		const ref = idSource(publicId(4))
		expect(ref !== null && isResolved(ref, [source(1)])).toBe(false)
	})
})
