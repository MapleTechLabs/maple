// Compares the dependency scanner's answer with Google's osv-scanner on the same lockfiles, against
// live OSV.dev. Prints one line per lockfile and every package where the two disagree.
// Run: bun packages/backend/scripts/depscan-vs-osv-scanner.ts <lockfile>...
import { EdgeCacheService, MemoryCacheBackendLive } from "@maple/cache"
import { packageKey } from "@maple/domain/package-advisories"
import { parseLockfile } from "@maple/lockfiles"
import { Console, Effect, Layer, Schema, Array as Arr, String as Str } from "effect"
import { FetchHttpClient } from "effect/http"
import { basename, dirname } from "node:path"
import { PackageAdvisoryCatalog } from "../src/services/security/PackageAdvisoryCatalog"

const OsvScannerOutput = Schema.Struct({
	results: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				packages: Schema.optionalKey(
					Schema.Array(
						Schema.Struct({
							package: Schema.Struct({
								name: Schema.String,
								version: Schema.String,
								ecosystem: Schema.String,
							}),
							groups: Schema.optionalKey(
								Schema.Array(
									Schema.Struct({
										ids: Schema.Array(Schema.String),
										aliases: Schema.optionalKey(Schema.Array(Schema.String)),
									}),
								),
							),
						}),
					),
				),
			}),
		),
	),
})
type OsvScannerOutput = typeof OsvScannerOutput.Type

const decodeOsvScannerOutput = Schema.decodeUnknownSync(Schema.fromJsonString(OsvScannerOutput))

const osvScanner = (path: string): OsvScannerOutput => {
	const run = Bun.spawnSync(["osv-scanner", "scan", "source", "--format", "json", "--lockfile", path])
	return decodeOsvScannerOutput(run.stdout.toString() || "{}")
}

const layer = PackageAdvisoryCatalog.layer.pipe(
	Layer.provide(EdgeCacheService.layer.pipe(Layer.provide(MemoryCacheBackendLive))),
	Layer.provide(FetchHttpClient.layer),
)

const compare = (path: string) =>
	Effect.gen(function* () {
		const manifests = new Map<string, string>()
		const manifest = Bun.file(`${dirname(path)}/package.json`)
		if (yield* Effect.promise(() => manifest.exists())) {
			const manifestText = yield* Effect.promise(() => manifest.text())
			manifests.set("package.json", manifestText)
		}
		const content = yield* Effect.promise(() => Bun.file(path).text())
		const parsed = yield* parseLockfile({ path: basename(path), content, manifests })
		const catalog = yield* PackageAdvisoryCatalog
		const { byPackage: ours } = yield* catalog.advisories(parsed.packages)

		const theirs = new Map(
			Arr.map(
				Arr.flatMap(osvScanner(path).results ?? [], (result) => result.packages ?? []),
				(pkg) => [
					`${pkg.package.ecosystem}:${pkg.package.name}@${pkg.package.version}`,
					Arr.map(pkg.groups ?? [], (group) => new Set([...group.ids, ...(group.aliases ?? [])])),
				],
			),
		)
		const lines = Arr.flatMap(parsed.packages, (ref) => {
			const key = packageKey(ref)
			const mine = Arr.map(
				ours.get(key) ?? [],
				(advisory) => new Set([advisory.id, ...advisory.aliases]),
			)
			// osv-scanner reports Go versions without the `v`.
			const other = theirs.get(key) ?? theirs.get(Str.replace("@v", "@")(key)) ?? []
			const missing = Arr.filter(
				other,
				(group) => !Arr.some(mine, (names) => Arr.some([...group], (id) => names.has(id))),
			)
			const extra = Arr.filter(
				mine,
				(names) => !Arr.some(other, (group) => Arr.some([...group], (id) => names.has(id))),
			)
			return missing.length === 0 && extra.length === 0
				? []
				: [
						`  ${key}: ${mine.length} vs ${other.length}; only osv-scanner ${Arr.join(
							Arr.map(missing, (g) => [...g][0]),
							",",
						)}; only ours ${Arr.join(
							Arr.map(extra, (n) => [...n][0]),
							",",
						)}`,
					]
		})
		const total = Arr.reduce([...ours.values()], 0, (sum, list) => sum + list.length)
		const theirTotal = Arr.reduce([...theirs.values()], 0, (sum, list) => sum + list.length)
		yield* Console.log(
			`${lines.length === 0 ? "MATCH" : "DIFF "} ${path}: ${parsed.packages.length} packages, ${total} advisories (osv-scanner ${theirTotal})`,
		)
		yield* Effect.forEach(lines, (line) => Console.log(line))
		return lines.length === 0
	})

const results = await Effect.runPromise(
	Effect.forEach(process.argv.slice(2), compare).pipe(Effect.provide(layer)),
)
process.exit(Arr.every(results, Boolean) ? 0 : 1)
