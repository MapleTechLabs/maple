// Compares the dependency scanner's answer with Google's osv-scanner on the same lockfiles, against
// live OSV.dev. Prints one line per lockfile and every package where the two disagree.
// Run: bun packages/backend/scripts/depscan-vs-osv-scanner.ts <lockfile>...
import { EdgeCacheService, MemoryCacheBackendLive } from "@maple/cache"
import { packageKey } from "@maple/domain/package-advisories"
import { parseLockfile } from "@maple/lockfiles"
import { Console, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { basename, dirname } from "node:path"
import { PackageAdvisoryCatalog } from "../src/services/security/PackageAdvisoryCatalog"

interface OsvScannerOutput {
	readonly results?: ReadonlyArray<{
		readonly packages?: ReadonlyArray<{
			readonly package: { readonly name: string; readonly version: string; readonly ecosystem: string }
			readonly groups?: ReadonlyArray<{
				readonly ids: ReadonlyArray<string>
				readonly aliases?: ReadonlyArray<string>
			}>
		}>
	}>
}

const osvScanner = (path: string): OsvScannerOutput => {
	const run = Bun.spawnSync(["osv-scanner", "scan", "source", "--format", "json", "--lockfile", path])
	return JSON.parse(run.stdout.toString() || "{}")
}

const layer = PackageAdvisoryCatalog.layer.pipe(
	Layer.provide(EdgeCacheService.layer.pipe(Layer.provide(MemoryCacheBackendLive))),
	Layer.provide(FetchHttpClient.layer),
)

const compare = (path: string) =>
	Effect.gen(function* () {
		const manifests = new Map<string, string>()
		const manifest = Bun.file(`${dirname(path)}/package.json`)
		if (yield* Effect.promise(() => manifest.exists()))
			manifests.set("package.json", yield* Effect.promise(() => manifest.text()))
		const content = yield* Effect.promise(() => Bun.file(path).text())
		const parsed = yield* parseLockfile({ path: basename(path), content, manifests })
		const catalog = yield* PackageAdvisoryCatalog
		const ours = yield* catalog.advisories(parsed.packages)

		const theirs = new Map(
			(osvScanner(path).results ?? [])
				.flatMap((result) => result.packages ?? [])
				.map((pkg) => [
					`${pkg.package.ecosystem}:${pkg.package.name}@${pkg.package.version}`,
					(pkg.groups ?? []).map((group) => new Set([...group.ids, ...(group.aliases ?? [])])),
				]),
		)
		const lines = parsed.packages.flatMap((ref) => {
			const key = packageKey(ref)
			const mine = (ours.get(key) ?? []).map((advisory) => new Set([advisory.id, ...advisory.aliases]))
			// osv-scanner reports Go versions without the `v`.
			const other = theirs.get(key) ?? theirs.get(key.replace("@v", "@")) ?? []
			const missing = other.filter(
				(group) => !mine.some((names) => [...group].some((id) => names.has(id))),
			)
			const extra = mine.filter(
				(names) => !other.some((group) => [...group].some((id) => names.has(id))),
			)
			return missing.length === 0 && extra.length === 0
				? []
				: [
						`  ${key}: ${mine.length} vs ${other.length}; only osv-scanner ${missing.map((g) => [...g][0]).join(",")}; only ours ${extra.map((n) => [...n][0]).join(",")}`,
					]
		})
		const total = [...ours.values()].reduce((sum, list) => sum + list.length, 0)
		const theirTotal = [...theirs.values()].reduce((sum, list) => sum + list.length, 0)
		yield* Console.log(
			`${lines.length === 0 ? "MATCH" : "DIFF "} ${path}: ${parsed.packages.length} packages, ${total} advisories (osv-scanner ${theirTotal})`,
		)
		yield* Effect.forEach(lines, (line) => Console.log(line))
		return lines.length === 0
	})

const results = await Effect.runPromise(
	// oxlint-disable-next-line effecttsgo/strict-effect-provide
	Effect.forEach(process.argv.slice(2), compare).pipe(Effect.provide(layer)),
)
process.exit(results.every(Boolean) ? 0 : 1)
