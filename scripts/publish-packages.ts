/**
 * Publish step of `.github/workflows/release.yml` (the changesets/action `publish-script`).
 *
 * `changeset publish` shells out to `npm publish` in a Bun workspace, which ships `workspace:*`
 * and `catalog:` ranges verbatim. So this packs each package with `bun pm pack` (which rewrites
 * them) and publishes the tarball with npm, which owns OIDC trusted publishing and provenance.
 *
 * Publishes every public workspace package whose current version is not on npm yet, then tags it
 * and reports the tag to the action through `CHANGESETS_OUTPUT` so it can push the tag and cut a
 * GitHub release. `--dry-run` packs and runs `npm publish --dry-run` without tagging.
 */
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Glob } from "bun"
import { Schema, Array as Arr, Record as Rec, String as Str } from "effect"

// Private apps carry no `version`; only publishable manifests must.
const WorkspaceManifest = Schema.Struct({
	name: Schema.String,
	version: Schema.optionalKey(Schema.String),
	private: Schema.optionalKey(Schema.Boolean),
	publishConfig: Schema.optionalKey(Schema.Struct({ access: Schema.optionalKey(Schema.String) })),
	dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
	peerDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
})
type WorkspaceManifest = typeof WorkspaceManifest.Type

interface Manifest extends WorkspaceManifest {
	readonly version: string
}

const decodeWorkspaceManifest = Schema.decodeUnknownSync(Schema.fromJsonString(WorkspaceManifest))
const decodeChangesetConfig = Schema.decodeUnknownSync(
	Schema.fromJsonString(Schema.Struct({ ignore: Schema.optionalKey(Schema.Array(Schema.String)) })),
)
const decodeRootManifest = Schema.decodeUnknownSync(
	Schema.fromJsonString(Schema.Struct({ workspaces: Schema.Array(Schema.String) })),
)
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

interface Candidate<M extends WorkspaceManifest = Manifest> {
	readonly dir: string
	readonly manifest: M
}

const root = resolve(import.meta.dir, "..")
const dryRun = process.argv.includes("--dry-run")

const run = (cmd: ReadonlyArray<string>, cwd = root, quiet = false) => {
	const result = Bun.spawnSync([...cmd], {
		cwd,
		stdout: quiet ? "pipe" : "inherit",
		stderr: quiet ? "pipe" : "inherit",
	})
	return {
		ok: result.exitCode === 0,
		stdout: result.stdout?.toString() ?? "",
		stderr: result.stderr?.toString() ?? "",
	}
}

const fail = (message: string): never => {
	console.error(`::error::${message}`)
	process.exit(1)
}

const changesetConfig = decodeChangesetConfig(readFileSync(join(root, ".changeset/config.json"), "utf8"))
const ignored = new Set(changesetConfig.ignore ?? [])
const rootManifest = decodeRootManifest(readFileSync(join(root, "package.json"), "utf8"))

const workspaces: ReadonlyArray<Candidate<WorkspaceManifest>> = Arr.flatMap(
	rootManifest.workspaces,
	(pattern) =>
		Arr.map(Array.from(new Glob(`${pattern}/package.json`).scanSync({ cwd: root })), (file) => ({
			dir: join(root, file, ".."),
			manifest: decodeWorkspaceManifest(readFileSync(join(root, file), "utf8")),
		})),
)

const isOnNpm = ({ name, version }: Manifest) =>
	Str.trim(run(["npm", "view", `${name}@${version}`, "version"], root, true).stdout) === version

const isTagged = (tag: string) =>
	Str.trim(run(["git", "ls-remote", "--tags", "origin", `refs/tags/${tag}`], root, true).stdout) !== ""

const outputFile = process.env.CHANGESETS_OUTPUT

// Tags the release locally and reports it so the action pushes the tag and cuts the GitHub release.
const reportRelease = ({ name, version }: Manifest) => {
	const tag = `${name}@${version}`
	if (!run(["git", "tag", "-a", tag, "-m", tag]).ok) fail(`git tag failed for ${tag}`)
	console.log(`New tag: ${tag}`)
	if (outputFile) {
		appendFileSync(outputFile, `${encodeJson({ type: "git-tag", tag, packageName: name })}\n`)
	}
}

const publishable: ReadonlyArray<Candidate> = Arr.flatMap(workspaces, ({ dir, manifest }) => {
	if (
		manifest.private === true ||
		manifest.publishConfig?.access !== "public" ||
		ignored.has(manifest.name)
	)
		return []
	const { version } = manifest
	return version === undefined
		? fail(`${manifest.name} is public but has no version`)
		: [{ dir, manifest: { ...manifest, version } }]
})
const [published, pending] = publishable.reduce<[Array<Candidate>, Array<Candidate>]>(
	([onNpm, notOnNpm], candidate) =>
		isOnNpm(candidate.manifest) ? [[...onNpm, candidate], notOnNpm] : [onNpm, [...notOnNpm, candidate]],
	[[], []],
)

// A rerun after a publish whose tag push or release failed: npm already has the version, so only
// the tag and release are still owed.
if (!dryRun) {
	for (const { manifest } of published) {
		if (!isTagged(`${manifest.name}@${manifest.version}`)) reportRelease(manifest)
	}
}

if (pending.length === 0) {
	console.log("Nothing to publish: every public package version is already on npm.")
	process.exit(0)
}

// A package goes after any pending package it depends on, so `workspace:*` resolves to a
// version that already exists on npm by the time its dependent is published.
const pendingNames = new Set(Arr.map(pending, ({ manifest }) => manifest.name))
const internalDeps = ({ manifest }: Candidate) =>
	Arr.filter(Rec.keys({ ...manifest.dependencies, ...manifest.peerDependencies }), (dep) =>
		pendingNames.has(dep),
	).length
const ordered = pending.toSorted((a, b) => internalDeps(a) - internalDeps(b))

console.log(
	`Publishing: ${Arr.join(
		Arr.map(ordered, ({ manifest }) => `${manifest.name}@${manifest.version}`),
		", ",
	)}`,
)

if (
	!run([
		"bunx",
		"turbo",
		"run",
		"build",
		...Arr.map(ordered, ({ manifest }) => `--filter=${manifest.name}`),
	]).ok
) {
	fail("build failed")
}

const packDir = mkdtempSync(join(tmpdir(), "maple-publish-"))

for (const { dir, manifest } of ordered) {
	const tag = `${manifest.name}@${manifest.version}`
	const tarball = join(
		packDir,
		`${Str.replace("/", "-")(Str.replace("@", "")(manifest.name))}-${manifest.version}.tgz`,
	)
	if (!run(["bun", "pm", "pack", "--filename", tarball], dir).ok) fail(`bun pm pack failed for ${tag}`)
	const publishArgs = ["npm", "publish", tarball, "--access", "public"]
	const publish = run(dryRun ? [...publishArgs, "--dry-run"] : [...publishArgs, "--provenance"], root, true)
	process.stdout.write(publish.stdout)
	process.stderr.write(publish.stderr)
	// `npm view` can serve a stale miss for a package created minutes ago, so a version published
	// out of band still lands here; npm rejecting it as a duplicate means it only needs its tag.
	if (
		!publish.ok &&
		!Str.includes("cannot publish over the previously published versions")(publish.stderr)
	) {
		fail(`npm publish failed for ${tag}`)
	}
	if (!publish.ok) console.log(`${tag} is already on npm, tagging only.`)
	if (!dryRun) reportRelease(manifest)
}
