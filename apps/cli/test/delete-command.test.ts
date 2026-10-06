import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { buildDeleteRequest, parseBefore, resolveDeleteBaseUrl, verifyStoreServer } from "../src/commands/delete"
import { Mode } from "../src/core/mode"
import { CliUsageError } from "../src/lib/errors"

const withMode = (resolved: Effect.Success<(typeof Mode.Service)["resolve"]>) =>
	Effect.runPromise(
		Effect.flip(resolveDeleteBaseUrl).pipe(
			Effect.provide(Layer.succeed(Mode, { resolve: Effect.succeed(resolved) })),
		),
	)

describe("maple delete is local-only", () => {
	const argv = process.argv
	afterEach(() => {
		process.argv = argv
	})

	test("refuses --remote before resolving any backend", async () => {
		process.argv = [...argv, "--remote"]
		const error = await withMode({ _tag: "local", baseUrl: "http://127.0.0.1:4318" })
		expect(error).toBeInstanceOf(CliUsageError)
		expect(error.message).toContain("--remote is not supported")
	})

	test("refuses when the active mode resolves to remote", async () => {
		const error = await withMode({ _tag: "remote", apiUrl: "https://api.maple.dev", token: "t", orgId: undefined })
		expect(error).toBeInstanceOf(CliUsageError)
		expect(error.message).toContain("the active mode is remote")
	})

	test("targets the resolved local server", async () => {
		const url = await Effect.runPromise(
			resolveDeleteBaseUrl.pipe(
				Effect.provide(
					Layer.succeed(Mode, {
						resolve: Effect.succeed({ _tag: "local" as const, baseUrl: "http://127.0.0.1:4318/" }),
					}),
				),
			),
		)
		expect(url).toBe("http://127.0.0.1:4318")
	})
})

describe("--before", () => {
	test("accepts an age or an absolute UTC timestamp", () => {
		expect(parseBefore("2h", 10 * 3_600_000)).toBe(8 * 3_600_000)
		expect(parseBefore("2026-10-01 12:00", 0)).toBe(Date.UTC(2026, 9, 1, 12))
		expect(parseBefore("yesterday", 0)).toBeNull()
	})
})

describe("delete request", () => {
	const flags = { service: undefined, namespace: undefined, env: undefined, beforeMs: undefined }
	const build = (input: Parameters<typeof buildDeleteRequest>[0]) =>
		Effect.runPromise(
			Effect.match(buildDeleteRequest(input), {
				onFailure: (error) => ({ error: error.message }),
				onSuccess: (request) => ({ request }),
			}),
		)

	test("needs a service or a namespace", async () => {
		expect(await build(flags)).toEqual({ error: "pass --service, --namespace, or both" })
		expect(await build({ ...flags, service: "  ", env: "prod" })).toEqual({
			error: "pass --service, --namespace, or both",
		})
	})

	test("reports an out-of-range value as invalid, not as a missing selector", async () => {
		expect(await build({ ...flags, service: "a".repeat(513) })).toEqual({ error: "invalid delete flags" })
		expect(await build({ ...flags, namespace: "pr-42", beforeMs: -1 })).toEqual({ error: "invalid delete flags" })
	})

	test("accepts a namespace alone or with a service, env and cutoff", async () => {
		expect(await build({ ...flags, namespace: "pr-42" })).toEqual({ request: { namespace: "pr-42" } })
		expect(await build({ service: " api ", namespace: "pr-42", env: "", beforeMs: 1_000.7 })).toEqual({
			request: { service: "api", namespace: "pr-42", env: "", beforeMs: 1_000 },
		})
	})
})

describe("token goes only to the store's own server", () => {
	const status = { service: "maple-local", pid: 4242, version: "x", url: "", dataDir: "/s/data", lastIngestAtMs: null } as const
	const discovery = JSON.stringify({ pid: 4242, url: "http://127.0.0.1:4318", dataDir: "/s/data", startedAt: "t" })
	const verify = (baseUrl: string, text: string | undefined, alive = true) =>
		Effect.runPromise(
			Effect.match(
				verifyStoreServer(baseUrl, status, {
					readDiscovery: () => {
						if (text === undefined) throw new Error("ENOENT")
						return text
					},
					isAlive: () => alive,
				}),
				{ onFailure: (error) => error.message, onSuccess: () => "ok" },
			),
		)

	test("accepts the live loopback server the discovery file names", async () => {
		expect(await verify("http://127.0.0.1:4318", discovery)).toBe("ok")
		expect(await verify("http://localhost:4318", discovery)).toBe("ok")
	})

	test("refuses a non-loopback target", async () => {
		expect(await verify("http://maple.home.arpa:4318", discovery)).toContain("only talks to a loopback server")
	})

	test("refuses a server that merely claims the store", async () => {
		expect(await verify("http://127.0.0.1:9999", discovery)).toContain("is not the live server")
		expect(await verify("http://127.0.0.1:4318", discovery.replace("4242", "1"))).toContain("is not the live server")
		expect(await verify("http://127.0.0.1:4318", undefined)).toContain("is not the live server")
		expect(await verify("http://127.0.0.1:4318", discovery, false)).toContain("is not the live server")
	})
})
