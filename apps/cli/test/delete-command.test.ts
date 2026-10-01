import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { parseBefore, resolveDeleteBaseUrl } from "../src/commands/delete"
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
