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

interface Manifest {
	readonly name: string
	readonly version: string
	readonly private?: boolean
	readonly publishConfig?: { readonly access?: string }
	readonly dependencies?: Readonly<Record<string, string>>
	readonly peerDependencies?: Readonly<Record<string, string>>
}

interface Candidate {
	readonly dir: string
	readonly manifest: Manifest
}

const root = resolve(import.meta.dir, "..")
const dryRun = process.argv.includes("--dry-run")

const run = (cmd: ReadonlyArray<string>, cwd = root, quiet = false) => {
	const result = Bun.spawnSync([...cmd], {
		cwd,
		stdout: quiet ? "pipe" : "inherit",
		stderr: quiet ? "pipe" : "inherit",
	})
	return { ok: result.exitCode === 0, stdout: result.stdout?.toString() ?? "" }
}

const fail = (message: string): never => {
	console.error(`::error::${message}`)
	process.exit(1)
}

const changesetConfig: { readonly ignore?: ReadonlyArray<string> } = JSON.parse(
	readFileSync(join(root, ".changeset/config.json"), "utf8"),
)
const ignored = new Set(changesetConfig.ignore ?? [])
const rootManifest: { readonly workspaces: ReadonlyArray<string> } = JSON.parse(
	readFileSync(join(root, "package.json"), "utf8"),
)

const workspaces: ReadonlyArray<Candidate> = rootManifest.workspaces.flatMap((pattern) =>
	Array.from(new Glob(`${pattern}/package.json`).scanSync({ cwd: root })).map((file) => ({
		dir: join(root, file, ".."),
		manifest: JSON.parse(readFileSync(join(root, file), "utf8")),
	})),
)

const isOnNpm = ({ name, version }: Manifest) =>
	run(["npm", "view", `${name}@${version}`, "version"], root, true).stdout.trim() === version

const isTagged = (tag: string) =>
	run(["git", "ls-remote", "--tags", "origin", `refs/tags/${tag}`], root, true).stdout.trim() !== ""

const outputFile = process.env.CHANGESETS_OUTPUT

// Tags the release locally and reports it so the action pushes the tag and cuts the GitHub release.
const reportRelease = ({ name, version }: Manifest) => {
	const tag = `${name}@${version}`
	if (!run(["git", "tag", "-a", tag, "-m", tag]).ok) fail(`git tag failed for ${tag}`)
	console.log(`New tag: ${tag}`)
	if (outputFile) {
		appendFileSync(outputFile, `${JSON.stringify({ type: "git-tag", tag, packageName: name })}\n`)
	}
}

const publishable = workspaces.filter(
	({ manifest }) =>
		manifest.private !== true &&
		manifest.publishConfig?.access === "public" &&
		!ignored.has(manifest.name),
)
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
const pendingNames = new Set(pending.map(({ manifest }) => manifest.name))
const internalDeps = ({ manifest }: Candidate) =>
	Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }).filter((dep) =>
		pendingNames.has(dep),
	).length
const ordered = pending.toSorted((a, b) => internalDeps(a) - internalDeps(b))

console.log(`Publishing: ${ordered.map(({ manifest }) => `${manifest.name}@${manifest.version}`).join(", ")}`)

if (
	!run(["bunx", "turbo", "run", "build", ...ordered.map(({ manifest }) => `--filter=${manifest.name}`)]).ok
) {
	fail("build failed")
}

const packDir = mkdtempSync(join(tmpdir(), "maple-publish-"))

for (const { dir, manifest } of ordered) {
	const tag = `${manifest.name}@${manifest.version}`
	const tarball = join(
		packDir,
		`${manifest.name.replace("@", "").replace("/", "-")}-${manifest.version}.tgz`,
	)
	if (!run(["bun", "pm", "pack", "--filename", tarball], dir).ok) fail(`bun pm pack failed for ${tag}`)
	const publishArgs = ["npm", "publish", tarball, "--access", "public"]
	if (!run(dryRun ? [...publishArgs, "--dry-run"] : [...publishArgs, "--provenance"]).ok) {
		fail(`npm publish failed for ${tag}`)
	}
	if (!dryRun) reportRelease(manifest)
}
