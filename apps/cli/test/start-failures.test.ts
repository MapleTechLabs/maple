import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Exit, Option } from "effect"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EXIT_START_REFUSED } from "../src/core/outcomes"
import {
	clearStartFailures,
	decideStartFailure,
	guardStartFailures,
	MAX_BACKOFF_MS,
	REPORT_INTERVAL_MS,
	startFailureFingerprint,
	startFailuresPath,
} from "../src/commands/start-failures"
import {
	BackgroundServerExitedError,
	LocalStoreDirtyError,
	ServerOptionError,
} from "../src/commands/server-errors"
import { ProjectorModuleError } from "../src/server/eventing/projector-modules"
import { ServerBindError } from "../src/server/serve"
import { ChdbError, describeChdbOpenFailure } from "../src/server/chdb"

const MINUTE = 60 * 1000

describe("decideStartFailure", () => {
	const fp = "@maple/cli/ChdbError:could not load libchdb"

	it("reports the first failure without waiting", () => {
		const decision = decideStartFailure(Option.none(), fp, 1_000, false)
		expect(decision.report).toBe(true)
		expect(decision.backoffMs).toBe(0)
		expect(decision.record.consecutive).toBe(1)
	})

	it("suppresses repeats within the hour and backs off up to the cap", () => {
		let record = decideStartFailure(Option.none(), fp, 0, false).record
		const backoffs: Array<number> = []
		const reports: Array<boolean> = []
		for (let i = 1; i <= 10; i++) {
			const decision = decideStartFailure(Option.some(record), fp, i * 1_000, false)
			backoffs.push(decision.backoffMs)
			reports.push(decision.report)
			record = decision.record
		}
		expect(reports.every((report) => !report)).toBe(true)
		expect(backoffs.slice(0, 4)).toEqual([0, 1_000, 2_000, 4_000])
		expect(Math.max(...backoffs)).toBe(MAX_BACKOFF_MS)
	})

	it("reports again once the interval has passed, while the loop continues", () => {
		const first = decideStartFailure(Option.none(), fp, 0, false).record
		const looping = { ...first, consecutive: 50, lastAtMs: REPORT_INTERVAL_MS - MINUTE }
		const decision = decideStartFailure(Option.some(looping), fp, REPORT_INTERVAL_MS, false)
		expect(decision.report).toBe(true)
		expect(decision.record.consecutive).toBe(51)
		expect(decision.record.lastReportedAtMs).toBe(REPORT_INTERVAL_MS)
	})

	it("starts a new streak for a different failure or after a quiet gap", () => {
		const first = decideStartFailure(Option.none(), fp, 0, false).record
		expect(decideStartFailure(Option.some(first), "other", MINUTE, false).report).toBe(true)
		const later = decideStartFailure(Option.some(first), fp, 30 * MINUTE, false)
		expect(later.report).toBe(true)
		expect(later.record.consecutive).toBe(1)
	})

	it("never waits for an interactive run", () => {
		const looping = { ...decideStartFailure(Option.none(), fp, 0, true).record, consecutive: 20 }
		expect(decideStartFailure(Option.some(looping), fp, 1_000, true).backoffMs).toBe(0)
	})

	it("treats failures that differ only by a number as the same", () => {
		const a = new ServerOptionError({ source: "x", message: "port 4340 is taken by PID 11" })
		const b = new ServerOptionError({ source: "x", message: "port 4341 is taken by PID 12" })
		expect(startFailureFingerprint(a)).toBe(startFailureFingerprint(b))
	})
})

describe("guardStartFailures", () => {
	let root: string
	let dataDir: string
	const originalExitCode = process.exitCode

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "maple-start-failures-"))
		dataDir = join(root, "data")
		process.exitCode = 0
	})
	afterEach(() => {
		rmSync(root, { recursive: true, force: true })
		process.exitCode = originalExitCode ?? 0
	})

	const run = <E>(error: E, options: { readonly detachedChild?: boolean } = {}) =>
		Effect.runPromiseExit(
			Effect.fail(error).pipe(guardStartFailures(dataDir, options), Effect.provide(BunServices.layer)),
		)
	const clear = () => Effect.runPromise(clearStartFailures(dataDir).pipe(Effect.provide(BunServices.layer)))
	const chdbFailure = new ChdbError({ message: "could not load libchdb at /x/libchdb.so" })

	it("fails the first time, then recovers repeats with the refusal exit code", async () => {
		const first = await run(chdbFailure)
		expect(Exit.isFailure(first)).toBe(true)
		expect(process.exitCode).toBe(EXIT_START_REFUSED)
		expect(existsSync(startFailuresPath(dataDir))).toBe(true)

		process.exitCode = 0
		const second = await run(chdbFailure)
		expect(Exit.isSuccess(second)).toBe(true)
		expect(process.exitCode).toBe(EXIT_START_REFUSED)
	})

	it("reports again after a successful start cleared the streak", async () => {
		await run(chdbFailure)
		await clear()
		expect(Exit.isFailure(await run(chdbFailure))).toBe(true)
	})

	it("dedupes a dirty-store refusal loop the same way", async () => {
		const dirty = new LocalStoreDirtyError({
			dataDir,
			policy: "fail",
			checkpointAvailable: true,
			message: "the local store was not cleanly closed. Run `maple restore --yes`",
		})
		expect(Exit.isFailure(await run(dirty))).toBe(true)
		expect(Exit.isSuccess(await run(dirty))).toBe(true)
		expect(process.exitCode).toBe(EXIT_START_REFUSED)
	})

	it("refuses a broken projector module with exit 78, so supervisors stop retrying", async () => {
		const broken = new ProjectorModuleError({
			path: "/modules/projectors.mjs",
			message: "projector module /modules/projectors.mjs: import failed",
		})
		expect(Exit.isFailure(await run(broken))).toBe(true)
		expect(process.exitCode).toBe(EXIT_START_REFUSED)
		expect(Exit.isSuccess(await run(broken))).toBe(true)
	})

	it("dedupes a taken port but exits 1, not 78, so supervisors retry", async () => {
		const bind = new ServerBindError({
			hostname: "127.0.0.1",
			port: 4318,
			message: "port 4318 is in use",
		})
		expect(Exit.isFailure(await run(bind))).toBe(true)
		expect(Exit.isSuccess(await run(bind))).toBe(true)
		expect(process.exitCode).toBe(1)
	})

	it("treats a start -d child that exited 78 as the same final refusal", async () => {
		const exited = (exitCode: number) =>
			new BackgroundServerExitedError({
				logPath: "/x/maple.log",
				exitCode,
				message: "exited during startup",
			})
		expect(Exit.isFailure(await run(exited(EXIT_START_REFUSED)))).toBe(true)
		expect(process.exitCode).toBe(EXIT_START_REFUSED)
		expect(Exit.isSuccess(await run(exited(EXIT_START_REFUSED)))).toBe(true)

		process.exitCode = 0
		expect(Exit.isFailure(await run(exited(1)))).toBe(true)
		expect(process.exitCode).toBe(0)
	})

	it("keeps a start -d child's streak apart from its parent's", async () => {
		expect(Exit.isFailure(await run(chdbFailure, { detachedChild: true }))).toBe(true)
		expect(Exit.isFailure(await run(chdbFailure))).toBe(true)
		expect(Exit.isSuccess(await run(chdbFailure, { detachedChild: true }))).toBe(true)
	})

	it("passes other failures through untouched", async () => {
		const exit = await run(new ServerOptionError({ source: "--host", message: "bad host" }))
		expect(Exit.isFailure(exit)).toBe(true)
		expect(process.exitCode).toBe(0)
		expect(existsSync(startFailuresPath(dataDir))).toBe(false)
	})
})

describe("describeChdbOpenFailure", () => {
	const raw =
		'Failed to open library "/Users/u/.maple/bin/libchdb.so": dlopen(/Users/u/.maple/bin/libchdb.so, 0x0001): ' +
		"tried: '/Users/u/.maple/bin/libchdb.so' (mis-aligned LINKEDIT string pool, fileOffset=0x13148434)"

	it("names the library, keeps the loader's reason and points at a reinstall", () => {
		const message = describeChdbOpenFailure(raw, "0.0.24")
		expect(message).toContain("/Users/u/.maple/bin/libchdb.so")
		expect(message).toContain("mis-aligned LINKEDIT string pool")
		expect(message).toContain("maple update --tag v0.0.24")
	})

	it("leaves other chDB failures as they were", () => {
		expect(describeChdbOpenFailure("chdb_connect returned NULL", "0.0.24")).toBe(
			"chdb_connect returned NULL",
		)
	})
})
