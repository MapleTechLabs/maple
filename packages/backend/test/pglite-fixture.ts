import assert from "node:assert/strict"
import { MemoryFS, type PGlite } from "@electric-sql/pglite"

// PGDATA used by PGlite's built-in filesystems. The snapshot is engine-version
// keyed, and the fixture isolation tests exercise this boundary on upgrades.
const PGDATA = "/pglite/data"

export interface PgliteFixture {
	readonly directories: ReadonlyArray<string>
	readonly files: ReadonlyArray<{
		readonly path: string
		readonly bytes: Uint8Array
		readonly modifiedAt: number
	}>
}

/** Read the migrated filesystem once, instead of parsing its tar for every test. */
export const capturePgliteFixture = (db: PGlite): PgliteFixture => {
	const fs = db.Module.FS
	const directories: string[] = []
	const files: Array<PgliteFixture["files"][number]> = []
	const visit = (directory: string): void => {
		directories.push(directory)
		for (const name of fs.readdir(directory)) {
			if (name === "." || name === "..") continue
			const path = `${directory}/${name}`
			const stat = fs.stat(path)
			if (fs.isDir(stat.mode)) visit(path)
			else files.push({ path, bytes: fs.readFile(path), modifiedAt: stat.mtime.getTime() })
		}
	}
	visit(PGDATA)
	return { directories, files }
}

/** Each instance owns a fresh MEMFS. Only the immutable fixture bytes are shared. */
export class FixtureMemoryFS extends MemoryFS {
	constructor(private readonly fixture: PgliteFixture) {
		super()
	}

	override async initialSyncFs(): Promise<void> {
		assert(this.pg, "PGlite must initialize the filesystem before restoring it")
		const fs = this.pg.Module.FS
		// The standard tar loader checks every ancestor for every file (1,375
		// files, only 27 directories). Create each directory once instead.
		for (const directory of this.fixture.directories) fs.mkdirTree(directory)
		for (const file of this.fixture.files) {
			// Never pass canOwn: true: Postgres writes must not mutate shared bytes.
			fs.writeFile(file.path, file.bytes)
			fs.utime(file.path, file.modifiedAt, file.modifiedAt)
		}
	}
}
