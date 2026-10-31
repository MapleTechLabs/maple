import fc from "fast-check"
import { describe, expect, it, vi } from "vitest"
import { normalizeIdentity } from "../identity/identity"
import { coerceTrackProps } from "./props"

/** No unpaired half of a surrogate pair: what strict JSON parsers require. */
const isWellFormed = (text: string): boolean =>
	!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)

const anything = fc.anything({
	stringUnit: "binary",
	withBigInt: true,
	withBoxedValues: true,
	withDate: true,
	withMap: true,
	withNullPrototype: true,
	withSet: true,
	withSparseArray: true,
	withTypedArray: true,
})

/**
 * Objects a host app can hand over by accident: getters that throw, trapping
 * Proxies, cycles. Generated as a spec and built inside the property: fast-check
 * itself probes generated values and would trip over a revoked Proxy.
 */
const hostile = fc.record({
	entries: fc.dictionary(fc.string({ unit: "binary", maxLength: 80 }), anything, { maxKeys: 40 }),
	kind: fc.constantFrom(
		"plain",
		"null-proto",
		"throwing-getter",
		"proxy-keys",
		"proxy-get",
		"cycle",
		"revoked",
	),
})

function buildHostile({ entries, kind }: { entries: Record<string, unknown>; kind: string }): object {
	switch (kind) {
		case "null-proto":
			return Object.assign(Object.create(null), entries)
		case "throwing-getter": {
			const throwing = {
				enumerable: true,
				get: (): never => {
					throw new Error("getter")
				},
			}
			return Object.defineProperties({ ...entries }, { boom: throwing, id: throwing, traits: throwing })
		}
		case "proxy-keys":
			return new Proxy(entries, {
				ownKeys: () => {
					throw new Error("ownKeys")
				},
			})
		case "proxy-get":
			return new Proxy(entries, {
				get: () => {
					throw new Error("get")
				},
			})
		case "cycle": {
			const cyclic = { ...entries }
			return Object.assign(cyclic, { self: cyclic, nested: { back: cyclic } })
		}
		case "revoked": {
			const { proxy, revoke } = Proxy.revocable(entries, {})
			revoke()
			return proxy
		}
		default:
			return entries
	}
}

const prototypeSnapshot = (): string => Object.getOwnPropertyNames(Object.prototype).sort().join(",")

/** A plain object holding only well-formed string keys and values within the caps. */
function expectStringMap(
	out: Readonly<Record<string, string>>,
	caps: { count: number; key: number; value: number },
): void {
	expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
	const entries = Object.entries(out)
	expect(entries.length).toBeLessThanOrEqual(caps.count)
	for (const [key, value] of entries) {
		expect(typeof value).toBe("string")
		expect(key.length).toBeGreaterThan(0)
		expect(key.length).toBeLessThanOrEqual(caps.key)
		expect(String(value).length).toBeLessThanOrEqual(caps.value)
		expect(isWellFormed(key)).toBe(true)
		expect(isWellFormed(String(value))).toBe(true)
	}
}

/**
 * Any value, or a hostile object built from a spec. `TrackProps` and
 * `IdentifyInput` are what callers are typed to pass; untyped callers pass anything.
 */
const input = fc.oneof(
	anything.map((value) => ({ value, spec: undefined })),
	hostile.map((spec) => ({ value: undefined, spec })),
)

describe("coerceTrackProps", () => {
	it("turns any input into a capped, well-formed string map without touching Object.prototype", () => {
		const before = prototypeSnapshot()
		fc.assert(
			fc.property(input, (generated) => {
				// SAFETY: deliberately outside `TrackProps`; untyped callers pass anything.
				const props = (
					generated.spec === undefined ? generated.value : buildHostile(generated.spec)
				) as never
				const out = coerceTrackProps(props)
				expectStringMap(out, { count: 32, key: 64, value: 1024 })
				const bytes = Object.entries(out).reduce(
					(sum, [key, value]) => sum + key.length + value.length,
					0,
				)
				expect(bytes).toBeLessThanOrEqual(8 * 1024)
				expect(prototypeSnapshot()).toBe(before)
			}),
		)
	})

	it("keeps every property of a small, well-behaved string bag", () => {
		fc.assert(
			fc.property(
				fc.dictionary(fc.stringMatching(/^[a-z_]{1,20}$/), fc.stringMatching(/^[ -~]{0,40}$/), {
					maxKeys: 10,
				}),
				(props) => {
					expect(coerceTrackProps(props)).toEqual(props)
				},
			),
		)
	})
})

describe("normalizeIdentity", () => {
	it("resolves any input to undefined or a capped, well-formed identity", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const before = prototypeSnapshot()
		const fields = fc.record(
			{ id: input, email: input, username: input, groupId: input, groupName: input, traits: input },
			{ requiredKeys: [] },
		)
		fc.assert(
			fc.property(fc.oneof(input, fields), (generated) => {
				const raw =
					"spec" in generated
						? generated.spec === undefined
							? generated.value
							: buildHostile(generated.spec)
						: Object.fromEntries(
								Object.entries(generated).map(([key, field]) => [
									key,
									field.spec === undefined ? field.value : buildHostile(field.spec),
								]),
							)
				// SAFETY: deliberately outside `IdentifyInput`; untyped callers pass anything.
				const resolved = normalizeIdentity(raw as never)
				expect(prototypeSnapshot()).toBe(before)
				if (resolved === undefined) return
				for (const field of [
					resolved.id,
					resolved.email,
					resolved.username,
					resolved.groupId,
					resolved.groupName,
				]) {
					if (field === undefined) continue
					expect(field.length).toBeGreaterThan(0)
					expect(field.length).toBeLessThanOrEqual(256)
					expect(field).toBe(field.trim())
					expect(isWellFormed(field)).toBe(true)
				}
				expectStringMap(resolved.traits, { count: 24, key: 64, value: 256 })
			}),
		)
		warn.mockRestore()
	})
})
