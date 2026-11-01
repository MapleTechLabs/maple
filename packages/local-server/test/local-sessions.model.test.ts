import { describe, expect, it } from "vitest"
import { Effect, Option, Schema } from "effect"
import fc from "fast-check"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { readDiscovery } from "../src/server-discovery"
import { serverDiscoveryPath, serverPidPath, storeOpenMarkerPath } from "../src/store-version"

// Several `alchemy dev` sessions of one stack, started and stopped in any order,
// against one store. Whatever the order, while any session runs exactly one of
// them owns the store, every session's Workers reach a live server on one stable
// endpoint, and once all have stopped the store is closed with no claim left.

const libchdbAvailable =
	(process.env.MAPLE_LIBCHDB !== undefined && existsSync(process.env.MAPLE_LIBCHDB)) ||
	existsSync(join(homedir(), ".maple", "bin", "libchdb.so")) ||
	existsSync(join(homedir(), ".maple", "bin", "libchdb.dylib"))
const describeWithChdb =
	process.env.MAPLE_REQUIRE_LIBCHDB === "1" ? describe : describe.skipIf(!libchdbAvailable)

const SESSION = join(import.meta.dir, "fixtures", "local-session.ts")

const decodeSessionLine = Schema.decodeUnknownSync(
	Schema.fromJsonString(
		Schema.Struct({
			endpoint: Schema.optionalKey(Schema.String),
			error: Schema.optionalKey(Schema.String),
		}),
	),
)

interface Session {
	readonly process: Bun.Subprocess<"ignore", "pipe", "pipe">
	readonly endpoint: string
	/** Everything the session logged, for the failure message. */
	readonly log: string[]
}

interface World {
	readonly dataDir: string
	readonly port: number
	readonly sessions: Session[]
}

const freePort = () => {
	const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
	const port = probe.port
	probe.stop(true)
	return port
}

/** The `SESSION ` line a fixture prints once started or refused. */
const readSession = async (child: Bun.Subprocess<"ignore", "pipe", "pipe">, log: string[]) => {
	const reader = child.stdout.getReader()
	const decoder = new TextDecoder()
	let buffered = ""
	const deadline = Date.now() + 20_000
	while (Date.now() < deadline) {
		const { value, done } = await reader.read()
		if (done) break
		const chunk = decoder.decode(value, { stream: true })
		buffered += chunk
		log.push(chunk)
		const line = buffered.split("\n").find((candidate) => candidate.startsWith("SESSION "))
		if (line !== undefined) {
			reader.releaseLock()
			// Keep draining so the child never blocks on a full pipe.
			void child.stdout.pipeTo(
				new WritableStream({ write: (bytes) => void log.push(decoder.decode(bytes)) }),
			)
			return decodeSessionLine(line.slice("SESSION ".length))
		}
	}
	throw new Error(`session printed no SESSION line: ${buffered}`)
}

const healthy = async (endpoint: string) => {
	try {
		// Generous: other work on the machine can stall a sidecar for seconds.
		const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(3000) })
		return response.ok
	} catch {
		return false
	}
}

/** The PID the claim file names, if any. */
const claimPid = (dataDir: string) => {
	const path = serverPidPath(dataDir)
	if (!existsSync(path)) return undefined
	const pid = Number.parseInt(readFileSync(path, "utf8"), 10)
	return Number.isInteger(pid) ? pid : undefined
}

/** The PID the discovery record names, if any. */
const discoveryPid = (dataDir: string) =>
	Option.getOrUndefined(
		Option.map(Effect.runSync(readDiscovery(serverDiscoveryPath(dataDir))), (found) => found.pid),
	)

interface Observed {
	readonly owner: number | undefined
	readonly discovered: number | undefined
	readonly open?: boolean
	readonly alive?: ReadonlyArray<number>
	readonly endpoints?: ReadonlyArray<string>
	readonly serving?: ReadonlyArray<boolean>
}

/** Poll until the invariants hold, or report how they last failed. */
const settled = async (world: World) => {
	const deadline = Date.now() + 30_000
	let last: Observed | undefined
	while (Date.now() < deadline) {
		const owner = claimPid(world.dataDir)
		const discovered = discoveryPid(world.dataDir)
		const alive = world.sessions.map((session) => session.process.pid)
		const endpoints = [...new Set(world.sessions.map((session) => session.endpoint))]
		if (alive.length === 0) {
			last = { owner, discovered, open: existsSync(storeOpenMarkerPath(world.dataDir)) }
			if (
				owner === undefined &&
				discovered === undefined &&
				!existsSync(storeOpenMarkerPath(world.dataDir))
			)
				return
		} else {
			const serving = await Promise.all(endpoints.map(healthy))
			last = { owner, discovered, alive, endpoints, serving }
			if (
				owner !== undefined &&
				alive.includes(owner) &&
				discovered === owner &&
				endpoints.length === 1 &&
				serving.every(Boolean)
			)
				return
		}
		await Bun.sleep(200)
	}
	const logs = world.sessions.map((session) => `--- PID ${session.process.pid}\n${session.log.join("")}`)
	throw new Error(`sessions never settled: ${JSON.stringify(last)}\n${logs.join("\n")}`)
}

class Start implements fc.AsyncCommand<{ running: number }, World> {
	toString = () => "start"
	check = (model: Readonly<{ running: number }>) => model.running < 3
	async run(model: { running: number }, world: World) {
		const child = Bun.spawn(["bun", SESSION, world.dataDir, String(world.port)], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		})
		const log: string[] = []
		void child.stderr.pipeTo(
			new WritableStream({ write: (bytes) => void log.push(new TextDecoder().decode(bytes)) }),
		)
		const printed = await readSession(child, log)
		expect(printed.error).toBeUndefined()
		world.sessions.push({ process: child, endpoint: printed.endpoint!, log })
		model.running++
		await settled(world)
	}
}

class Stop implements fc.AsyncCommand<{ running: number }, World> {
	constructor(readonly pick: number) {}
	toString = () => `stop(${this.pick})`
	check = (model: Readonly<{ running: number }>) => model.running > 0
	async run(model: { running: number }, world: World) {
		const [session] = world.sessions.splice(this.pick % world.sessions.length, 1)
		session!.process.kill("SIGTERM")
		// A session that cannot close within the deadline is a failure, not a hung test.
		const exited = await Promise.race([
			session!.process.exited,
			Bun.sleep(30_000).then(() => "timed out"),
		])
		if (exited === "timed out") session!.process.kill("SIGKILL")
		expect({ exited, log: exited === 0 ? "" : session!.log.join("") }).toEqual({ exited: 0, log: "" })
		model.running--
		await settled(world)
	}
}

const commands = [fc.constant(new Start()), fc.nat(5).map((pick) => new Stop(pick))]

describeWithChdb("several alchemy dev sessions on one store", () => {
	it("always have exactly one owner, one live endpoint, and a clean store at the end", async () => {
		await fc.assert(
			fc.asyncProperty(fc.commands(commands, { maxCommands: 7 }), async (sequence) => {
				const root = mkdtempSync(join(tmpdir(), "maple-local-sessions-"))
				const world: World = { dataDir: join(root, "data"), port: freePort(), sessions: [] }
				try {
					await fc.asyncModelRun(() => ({ model: { running: 0 }, real: world }), sequence)
					// Stop whoever is left, so the run always ends on a closed store.
					while (world.sessions.length > 0)
						await new Stop(0).run({ running: world.sessions.length }, world)
				} finally {
					for (const session of world.sessions) session.process.kill("SIGKILL")
					rmSync(root, { recursive: true, force: true })
				}
			}),
			{ numRuns: 6, endOnFailure: true },
		)
	}, 600_000)
})
