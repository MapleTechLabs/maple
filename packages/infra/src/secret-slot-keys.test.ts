import { Array as Arr, Effect, Exit, Layer, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { assert, describe, expect, it } from "vitest"
import { clickHousePasswordSlotKeys, warehouseTokenByName } from "./secret-slot-keys.ts"

const master = (fill: number) => Redacted.make(Buffer.alloc(32, fill).toString("base64"))

// The fixture master's slot keys, pinned the same in apps/ingest/src/main.rs (FIXTURE_SLOT_KEYS).
const FIXTURE_SLOT_KEYS = "IGjfnBNl:DxboU6BYcIHPRlnXrZyrpik+g9IlCixfjGcrpISh4AU="
const OTHER_SLOT_KEYS = "KU8b1-XB:KqvCSNzLCZiT7nAao9hlAQdGTYhMVsvyIyRhG2lgsPI="

const derive = (primary: Redacted.Redacted, decryptOnly: Option.Option<Redacted.Redacted>) =>
	Effect.runSyncExit(clickHousePasswordSlotKeys({ primary, decryptOnly }))

describe("clickHousePasswordSlotKeys", () => {
	it("derives `<keyId>:<subkey>` for the fixture master the gateway's tests open", () => {
		const exit = derive(master(5), Option.none())
		assert(Exit.isSuccess(exit))
		expect(Redacted.value(exit.value.value)).toBe(FIXTURE_SLOT_KEYS)
	})

	it("lists the primary first, then each decrypt-only key once", () => {
		const exit = derive(
			master(6),
			Option.some(Redacted.make(` ${Redacted.value(master(5))} ,, ${Redacted.value(master(6))}`)),
		)
		assert(Exit.isSuccess(exit))
		expect(Redacted.value(exit.value.value)).toBe(`${OTHER_SLOT_KEYS},${FIXTURE_SLOT_KEYS}`)
	})

	it("fails on a master that is not 32 base64 bytes, without echoing it", () => {
		const exit = derive(Redacted.make("not-a-key"), Option.none())
		assert(Exit.isFailure(exit))
		expect(String(exit.cause)).toContain("MAPLE_INGEST_KEY_ENCRYPTION_KEY must be base64")
		expect(String(exit.cause)).not.toContain("not-a-key")
		expect(Exit.isFailure(derive(master(5), Option.some(Redacted.make("short"))))).toBe(true)
	})
})

describe("warehouseTokenByName", () => {
	const lookup = (respond: (request: Request) => Response) => {
		const seen: Array<Request> = []
		const run = warehouseTokenByName(
			"https://api.example.test/",
			Redacted.make("admin"),
			"ingest_append",
		).pipe(
			Effect.provide(
				FetchHttpClient.layer.pipe(
					Layer.provide(
						Layer.succeed(FetchHttpClient.Fetch, async (input, init) => {
							const request = new Request(input, init)
							seen.push(request)
							return respond(request)
						}),
					),
				),
			),
		)
		return { run, seen }
	}

	it("hands on the named token's value, asked for with the admin token", async () => {
		const { run, seen } = lookup(() => Response.json({ token: "p.append-only", name: "ingest_append" }))
		const derived = await Effect.runPromise(run)
		expect(Redacted.value(derived.value)).toBe("p.append-only")
		expect(Arr.map(seen, (request) => [request.url, request.headers.get("authorization")])).toEqual([
			["https://api.example.test/v0/tokens/ingest_append", "Bearer admin"],
		])
	})

	it("fails with the token's name when the warehouse does not have it", async () => {
		const { run } = lookup(() => new Response("not found", { status: 404 }))
		const exit = await Effect.runPromiseExit(run)
		assert(Exit.isFailure(exit))
		expect(Exit.findErrorOption(exit).pipe(Option.map((error) => error.tokenName))).toEqual(
			Option.some("ingest_append"),
		)
	})
})
