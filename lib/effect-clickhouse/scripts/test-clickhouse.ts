#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Config, Effect, Path } from "effect"
import { check, runCommand } from "./release-support"

const release = process.argv.includes("--release")
const program = Effect.gen(function* () {
	const endpoint = yield* Config.string("EFFECT_CLICKHOUSE_TEST_URL").pipe(Config.withDefault(""))
	yield* check(
		endpoint.trim().length > 0,
		"live-configuration",
		"EFFECT_CLICKHOUSE_TEST_URL is required; refusing to skip live tests.",
	)
	const path = yield* Path.Path
	const root = yield* path.fromFileUrl(new URL("..", import.meta.url))
	const commands = release
		? [["run", "build"], ["run", "typecheck"], ["run", "test"], ["scripts/check-package.ts"]]
		: [["x", "--no-install", "vitest", "run", "tests/"]]
	for (const args of commands) yield* runCommand("bun", args, root)
})

// This is the CLI entry point; provide platform services once at the boundary.
// oxlint-disable-next-line effecttsgo/strict-effect-provide
program.pipe(Effect.provide(BunServices.layer), BunRuntime.runMain)
