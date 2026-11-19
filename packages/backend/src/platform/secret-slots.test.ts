import { describe, expect, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { openSecret, parseSecretKeyring } from "./SecretBox"
import type { UptimeMonitorConfig, UptimeStep } from "@maple/domain/uptime"
import { clickHousePasswordSlot, uptimeMonitorHeadersSlot } from "./secret-slots"

// The ingest gateway opens this column in Rust. The same triples are pinned in
// apps/ingest/src/main.rs, so a change to either envelope breaks one of the two tests.
const fixtureKeyring = parseSecretKeyring(
	{ primary: Buffer.alloc(32, 5).toString("base64"), decryptOnly: Option.none() },
	(message) => message,
)

const v2Fixture = {
	ciphertext: "v2.IGjfnBNl.1HbzraIYWPNUxiGCnA==",
	iv: "3gBID0+h49Y9q+SD",
	tag: "s2cyY7uChmyKqIcJzE8m7Q==",
}

/** Sealed for org_fixture while `ch_url` was `https://ch.example.com:8443`. */
const v3Fixture = {
	ciphertext: "v3.IGjfnBNl.xeDTFXH6xa2O+HjUIA==",
	iv: "AAECAwQFBgcICQoL",
	tag: "kDzWdYJ8UBBoQYMWpL9KSg==",
}

const open = (chUrl: string, stored: typeof v2Fixture) =>
	Effect.flatMap(fixtureKeyring, (keyring) =>
		openSecret(keyring, clickHousePasswordSlot, { orgId: "org_fixture", chUrl }, stored, (m) => m),
	)

describe("clickHousePasswordSlot", () => {
	it.effect("refuses the v2 fixture: it is not bound to ch_url", () =>
		Effect.gen(function* () {
			const error = yield* open("https://ch.example.com:8443", v2Fixture).pipe(Effect.flip)
			expect(error).toBe("Stored value is not bound to its destination")
		}),
	)

	it.effect("opens the v3 fixture only while ch_url is the one it was sealed for", () =>
		Effect.gen(function* () {
			expect(yield* open("https://ch.example.com:8443", v3Fixture)).toBe("ch-secret-123")
			const moved = yield* open("https://attacker.example:8443", v3Fixture).pipe(Effect.flip)
			expect(moved).toBe("Decryption failed")
		}),
	)
})

describe("uptimeMonitorHeadersSlot", () => {
	const step = (url: string, extract: UptimeStep["extract"] = []): UptimeStep => ({
		name: url,
		method: "GET",
		url,
		headers: {},
		assertions: [],
		extract,
	})
	const multistep = (steps: ReadonlyArray<UptimeStep>): UptimeMonitorConfig => ({
		_tag: "multistep",
		steps,
		timeoutMs: 10_000,
	})
	const destinationOf = (config: UptimeMonitorConfig) =>
		uptimeMonitorHeadersSlot.destination?.({ orgId: "org_a", id: "mon_1", config })

	// A later step's host can be a variable an earlier step filled: changing where that value is
	// read from moves the request as surely as changing its URL.
	it("binds a multi-step check to every step's URL and what each step extracts", () => {
		const login = step("https://api.example/login", [
			{ name: "api", from: { _tag: "json_path", path: "$.endpoint" } },
		])
		const original = destinationOf(multistep([login, step("{{api}}/me")]))
		const otherPath = destinationOf(
			multistep([{ ...login, url: "https://api.example/echo?x=1" }, step("{{api}}/me")]),
		)
		const otherExtract = destinationOf(
			multistep([
				{ ...login, extract: [{ name: "api", from: { _tag: "json_path", path: "$.x" } }] },
				step("{{api}}/me"),
			]),
		)
		expect(otherPath).not.toEqual(original)
		expect(otherExtract).not.toEqual(original)
		expect(destinationOf(multistep([login, step("{{api}}/me")]))).toEqual(original)
	})

	it("binds an HTTP check to its host only", () => {
		const http = (url: string): UptimeMonitorConfig => ({
			_tag: "http",
			url,
			method: "GET",
			headers: {},
			assertions: [],
			timeoutMs: 5000,
		})
		expect(destinationOf(http("https://a.example/one"))).toEqual(
			destinationOf(http("https://a.example/two")),
		)
		expect(destinationOf(http("https://b.example/one"))).not.toEqual(
			destinationOf(http("https://a.example/one")),
		)
	})
})
