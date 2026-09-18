/**
 * Preflight for `drizzle-kit migrate` on a database whose
 * `drizzle.__drizzle_migrations` table predates drizzle 1.0.
 *
 * The v1 migrator upgrades that table once, matching every existing row to a
 * local migration folder by `created_at` truncated to the second, then by hash,
 * and refuses to run if any row matches nothing. Rows like that exist wherever a
 * migration was applied and later renumbered or re-timestamped, or came from a
 * branch that never merged. This applies the same rules ahead of time and says
 * which row is which, so the fix is a deliberate UPDATE or DELETE rather than a
 * failed deploy.
 *
 *   DATABASE_URL=postgres://… bun scripts/migrations-preflight.ts
 *
 * It also lists every local migration no row matches, because the v1 migrator
 * applies all of them (the 0.x migrator only applied those newer than the
 * newest recorded timestamp). One whose DDL is already in the schema must be
 * recorded, not replayed.
 *
 * Read-only. Exits 1 when the migrator would refuse.
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import postgres from "postgres"
import { listBundledMigrations } from "../src/migrate"

const migrationsFolder = resolve(import.meta.dir, "../drizzle")

const url = process.env.DATABASE_URL ?? "postgres://maple:maple@localhost:5499/maple"

interface LocalMigration {
	readonly name: string
	readonly suffix: string
	readonly millis: number
	readonly hash: string
}

const folderMillis = (name: string): number => {
	const stamp = name.slice(0, 14)
	const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}.000Z`
	return Date.parse(iso)
}

const locals: ReadonlyArray<LocalMigration> = listBundledMigrations().map(({ name, sqlPath }) => ({
	name,
	suffix: name.slice(15),
	millis: folderMillis(name),
	hash: createHash("sha256").update(readFileSync(sqlPath)).digest("hex"),
}))
const byMillis = new Map<number, Array<LocalMigration>>()
const byHash = new Map<string, LocalMigration>()
for (const local of locals) {
	byMillis.set(local.millis, [...(byMillis.get(local.millis) ?? []), local])
	byHash.set(local.hash, local)
}

/** The migration name a historical path carried: `0003_premium_korg.sql` or `<stamp>_premium_korg/migration.sql`. */
const nameFromPath = (path: string): string | undefined => {
	const folder = /\/(\d{14})_([^/]+)\/migration\.sql$/.exec(path)
	if (folder) return folder[2]
	const flat = /\/\d{4}_([^/]+)\.sql$/.exec(path)
	return flat ? flat[1] : undefined
}

interface HistoricalBlob {
	readonly oid: string
	/** Every migration name this exact SQL has been filed under. More than one is ambiguous. */
	readonly names: ReadonlySet<string>
}

/**
 * Every migration SQL blob this checkout's git history has ever held, keyed by
 * its sha256. `rev-list --objects` reports a blob once per path it was reached
 * through, so a renumbered file shows up under each of its names; all of them
 * are kept, and a digest that maps to more than one name is left to a human.
 */
const historicalBlobs = (): Map<string, HistoricalBlob> => {
	const blobs = new Map<string, { oid: string; names: Set<string> }>()
	const listing = spawnSync("git", ["rev-list", "--all", "--objects", "--", "drizzle"], {
		encoding: "utf8",
	})
	if (listing.status !== 0) return blobs
	const digests = new Map<string, string>()
	for (const line of listing.stdout.split("\n")) {
		const [oid, path] = line.split(" ", 2)
		if (!oid || !path?.endsWith(".sql")) continue
		let digest = digests.get(oid)
		if (digest === undefined) {
			const blob = spawnSync("git", ["cat-file", "blob", oid])
			if (blob.status !== 0) continue
			digest = createHash("sha256").update(blob.stdout).digest("hex")
			digests.set(oid, digest)
		}
		const entry = blobs.get(digest) ?? { oid, names: new Set<string>() }
		const name = nameFromPath(path)
		if (name !== undefined) entry.names.add(name)
		blobs.set(digest, entry)
	}
	return blobs
}

/**
 * The v1 migrator applies every unrecorded folder, where the 0.x migrator only
 * applied those newer than the newest recorded timestamp. A migration whose
 * DDL reached the schema without a row used to be skipped and now fails on the
 * objects that already exist, so say exactly what will run.
 */
const reportPending = (recordedNames: ReadonlySet<string>): void => {
	const pending = locals.filter((local) => !recordedNames.has(local.name))
	console.log(`\n${pending.length} local migration(s) have no row and WILL be applied by the v1 migrator:`)
	for (const local of pending) {
		const first = readFileSync(resolve(migrationsFolder, local.name, "migration.sql"), "utf8")
			.split("\n")
			.find((line) => /^(create|alter|drop)\b/i.test(line))
		console.log(`  ${local.name}\n    ${first?.slice(0, 110) ?? "(no DDL statement)"}`)
	}
	if (pending.length > 0) {
		console.log(
			"  If one of these already reached the schema without a row, record it instead of replaying it:\n" +
				"  INSERT INTO drizzle.__drizzle_migrations (hash, created_at, name) VALUES ('<hash>', <created_at>, '<name>');",
		)
		for (const local of pending)
			console.log(`    ${local.name}: hash ${local.hash} created_at ${local.millis}`)
	}
}

const sql = postgres(url, { max: 1, fetch_types: false })
try {
	const columns = await sql<{ column_name: string }[]>`
		select column_name from information_schema.columns
		where table_schema = 'drizzle' and table_name = '__drizzle_migrations' order by ordinal_position`
	if (columns.length === 0) {
		console.log("No drizzle.__drizzle_migrations table: a fresh database, nothing to upgrade.")
		process.exit(0)
	}
	if (columns.some((c) => c.column_name === "name")) {
		console.log("Migrations table is already on the v1 layout (has `name`); the upgrade will not run.")
		const named = await sql<{ name: string | null }[]>`select name from drizzle.__drizzle_migrations`
		reportPending(new Set(named.flatMap((row) => (row.name === null ? [] : [row.name]))))
		process.exit(0)
	}
	const rows = await sql<{ id: number; created_at: string; hash: string }[]>`
		select id, created_at, hash from drizzle.__drizzle_migrations order by id asc`

	const orphans: Array<{ id: number; createdAt: number; hash: string }> = []
	const matchedNames = new Set<string>()
	for (const row of rows) {
		const createdAt = Number(row.created_at)
		const millis = Math.floor(createdAt / 1000) * 1000
		const candidates = byMillis.get(millis)
		const found =
			candidates && candidates.length === 1
				? candidates[0]
				: candidates && candidates.length > 1
					? candidates.find((c) => c.hash === row.hash)
					: byHash.get(row.hash)
		if (found) matchedNames.add(found.name)
		else orphans.push({ id: row.id, createdAt, hash: row.hash })
	}
	console.log(
		`${rows.length} rows, ${matchedNames.size} match a local migration, ${orphans.length} would make the migrator refuse.`,
	)

	reportPending(matchedNames)

	if (orphans.length === 0) process.exit(0)

	const history = historicalBlobs()
	const recorded = new Set(rows.map((r) => Math.floor(Number(r.created_at) / 1000) * 1000))
	for (const orphan of orphans) {
		console.log(
			`\nrow ${orphan.id}: created_at ${new Date(orphan.createdAt).toISOString()} hash ${orphan.hash.slice(0, 12)}…`,
		)
		const historical = history.get(orphan.hash)
		if (!historical) {
			console.log("  not in this checkout's history: applied from another branch, decide by hand")
			continue
		}
		const names = [...historical.names]
		if (names.length !== 1) {
			console.log(
				`  this SQL was filed under ${names.length} names (${names.join(", ") || "none recognisable"}): decide by hand`,
			)
			continue
		}
		const name = names[0]!
		const currents = locals.filter((l) => l.suffix === name)
		console.log(`  is the historical ${name}`)
		if (currents.length !== 1) {
			console.log(`  ${currents.length} current migrations carry that name: decide by hand`)
			continue
		}
		const current = currents[0]!
		if (recorded.has(current.millis)) {
			console.log(
				`  superseded: the current ${current.name} is recorded on its own row, so this one is a leftover`,
			)
			console.log(`  DELETE FROM drizzle.__drizzle_migrations WHERE id = ${orphan.id};`)
		} else if (current.hash === orphan.hash) {
			// Same SQL under a new timestamp: the row only needs to point at the folder.
			console.log(`  renumbered as ${current.name} with identical SQL; point the row at it`)
			console.log(
				`  UPDATE drizzle.__drizzle_migrations SET created_at = ${current.millis} WHERE id = ${orphan.id};`,
			)
		} else {
			// The SQL changed after this version ran, so the current migration has
			// statements this database never saw. No generated UPDATE: relabelling
			// the row would record them as applied.
			console.log(
				`  renumbered as ${current.name} but the SQL differs; this database ran the OLD version`,
			)
			console.log(`  git diff ${historical.oid} HEAD:packages/db/drizzle/${current.name}/migration.sql`)
			console.log("  apply whatever the current version adds by hand, then")
			console.log(
				`  UPDATE drizzle.__drizzle_migrations SET created_at = ${current.millis}, hash = '${current.hash}' WHERE id = ${orphan.id};`,
			)
		}
	}
	process.exit(1)
} finally {
	await sql.end()
}
