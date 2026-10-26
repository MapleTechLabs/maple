import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { UptimeDnsConfig } from "@maple/domain/uptime"
import { DnsLookupService, type DnsLookup, DnsQueryError, UptimeDnsProbe } from "./UptimeDnsProbe"

const decodeConfig = Schema.decodeUnknownSync(UptimeDnsConfig)
const dnsConfig = (fields: Record<string, unknown>) =>
	decodeConfig({ _tag: "dns", hostname: "example.com", recordType: "A", timeoutMs: 5_000, ...fields })

const ZONE = new Map<string, ReadonlyArray<string>>([
	["A example.com", ["93.184.216.34", "93.184.216.35"]],
	["MX example.com", ["mx1.example.com", "mx2.example.com"]],
	["TXT example.com", ["v=spf1 include:_spf.example.net ~all"]],
])

const zoneLookup: DnsLookup = (hostname, recordType) => {
	const answers = ZONE.get(`${recordType} ${hostname}`)
	if (answers !== undefined) return Effect.succeed(answers)
	return Effect.fail(
		new DnsQueryError({
			message: `queryA ENOTFOUND ${hostname}`,
			code: hostname === "example.com" ? "ENODATA" : "ENOTFOUND",
		}),
	)
}

const probeWith = (lookup: DnsLookup, config: ReturnType<typeof dnsConfig>) =>
	Effect.gen(function* () {
		const dns = yield* UptimeDnsProbe
		return yield* dns.probe(config)
	}).pipe(Effect.provide(UptimeDnsProbe.layer.pipe(Layer.provide(Layer.succeed(DnsLookupService, lookup)))))

describe("UptimeDnsProbe", () => {
	it.effect("is up when the name resolves, and when any answer matches the expected value", () =>
		Effect.gen(function* () {
			assert.isTrue((yield* probeWith(zoneLookup, dnsConfig({}))).ok)
			assert.isTrue((yield* probeWith(zoneLookup, dnsConfig({ expected: "93.184.216.35" }))).ok)
			// MX compares the exchange, case- and root-dot-insensitive.
			const mx = yield* probeWith(
				zoneLookup,
				dnsConfig({ recordType: "MX", expected: "MX2.example.com." }),
			)
			assert.isTrue(mx.ok)
			const txt = yield* probeWith(
				zoneLookup,
				dnsConfig({ recordType: "TXT", expected: "v=spf1 include:_spf.example.net ~all" }),
			)
			assert.isTrue(txt.ok)
		}),
	)

	it.effect("a mismatch lists what it found", () =>
		Effect.gen(function* () {
			const outcome = yield* probeWith(zoneLookup, dnsConfig({ expected: "203.0.113.9" }))
			assert.deepStrictEqual(
				{ ok: outcome.ok, error: outcome.error, type: outcome.errorType },
				{
					ok: false,
					error: "A records for example.com are 93.184.216.34, 93.184.216.35, expected 203.0.113.9",
					type: "assertion",
				},
			)
		}),
	)

	it.effect("NXDOMAIN and a missing record type are different sentences", () =>
		Effect.gen(function* () {
			const nx = yield* probeWith(zoneLookup, dnsConfig({ hostname: "nope.example.org" }))
			assert.deepStrictEqual(
				{ ok: nx.ok, error: nx.error, type: nx.errorType },
				{ ok: false, error: "nope.example.org does not exist (NXDOMAIN)", type: "dns" },
			)
			const nodata = yield* probeWith(zoneLookup, dnsConfig({ recordType: "AAAA" }))
			assert.strictEqual(nodata.error, "example.com has no AAAA records")
		}),
	)

	it.effect("times out after the configured timeout", () =>
		Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(
				probeWith(() => Effect.never, dnsConfig({ timeoutMs: 2_000 })),
			)
			yield* TestClock.adjust(Duration.seconds(2))
			const outcome = yield* Fiber.join(fiber)
			assert.deepStrictEqual(
				{ error: outcome.error, type: outcome.errorType },
				{ error: "DNS query timed out after 2 s", type: "timeout" },
			)
		}),
	)
})
