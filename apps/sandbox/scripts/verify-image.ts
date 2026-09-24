/**
 * Runs the checkout and command scripts this Worker generates inside the real
 * container image, and checks what they actually did.
 *
 * The unit tests assert what the scripts *say*; this asserts what they *do*. It
 * is the only layer that catches the image's own behaviour — that `mktemp -d`
 * makes a directory the agent account cannot enter, that a git flag shipped
 * after this image's git, that `/proc/<pid>/cmdline` is readable across accounts.
 *
 *   bun run --cwd apps/sandbox verify:image
 *
 * Needs Docker and roughly a gigabyte for the image. `--cap-add SYS_ADMIN` is
 * passed because Cloudflare's runtime is expected to allow a network namespace;
 * run with `MAPLE_SANDBOX_NO_CAPS=1` to prove the opposite case, where the
 * wrapper must refuse to run the command at all rather than run it with egress.
 */
import { execFileSync, spawnSync } from "node:child_process"
import {
	SANDBOX_COMMAND_ENV,
	SANDBOX_MIRROR_DIR,
	SANDBOX_RUN_AS_USER,
	SANDBOX_SEED_DIR,
	SANDBOX_SNAPSHOT_DIR,
	SANDBOX_WORKSPACE_ROOT,
	SandboxCheckout,
	sandboxCredentialPath,
	shellQuote,
} from "@maple/domain/sandbox"
import { checkoutDir, cloneScript, parseTrailer, snapshotScript, wrapCommand } from "../src/checkout.ts"

const IMAGE = "docker.io/cloudflare/sandbox:0.12.10"
const TOKEN = "ghs_a_secret_that_must_never_land_on_disk"
const ISOLATION_EXPECTED = process.env.MAPLE_SANDBOX_NO_CAPS ? "unavailable" : "isolated"

/**
 * The fixture repository, built identically in every container.
 *
 * Fixed author, committer and dates make the commit hash deterministic, which is
 * what lets the harness generate a clone script for a real SHA: the hash is read
 * from one throwaway container and every later one rebuilds the same commit.
 */
const FIXTURE = [
	"export GIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=t@example.com",
	"export GIT_COMMITTER_NAME=Test GIT_COMMITTER_EMAIL=t@example.com",
	"export GIT_AUTHOR_DATE='2026-01-01T00:00:00+0000' GIT_COMMITTER_DATE='2026-01-01T00:00:00+0000'",
	"mkdir -p /work/src && cd /work/src",
	"git init --quiet -b main .",
	"mkdir -p src",
	`printf 'export const total = 1\nthrow new Error(%s)\n' \"'card declined'\" > src/checkout.ts`,
	"printf 'a\n' > README.md",
	"git add -A && git commit --quiet -m first",
	// A bare origin the clone can reach with no network.
	"git clone --quiet --bare /work/src /origin.git",
].join("\n")

/** A second commit on `main`, pushed to the origin: what the next pull request review checks out. */
const SECOND_COMMIT = [
	"export GIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=t@example.com",
	"export GIT_COMMITTER_NAME=Test GIT_COMMITTER_EMAIL=t@example.com",
	"export GIT_AUTHOR_DATE='2026-01-02T00:00:00+0000' GIT_COMMITTER_DATE='2026-01-02T00:00:00+0000'",
	"cd /work/src",
	"printf 'b\n' >> README.md",
	"git commit --quiet -am second",
	"git push --quiet /origin.git main",
	"cd /",
].join("\n")

/** Run the real clone script for `target` inside the current container, reporting its exit. */
const cloneFor = (target: SandboxCheckout, label: string) =>
	[
		`printf '%s' ${shellQuote(TOKEN)} > ${sandboxCredentialPath(target.sha)}`,
		"(",
		cloneScript(target),
		`) > /tmp/clone-${label}.log 2>&1`,
		`echo "${label}_EXIT=$?"`,
	].join("\n")

let failures = 0
const check = (name: string, ok: boolean, detail = "") => {
	if (ok) console.log(`  ok    ${name}`)
	else {
		failures += 1
		console.log(`  FAIL  ${name}${detail ? `\n        ${detail.replaceAll("\n", "\n        ")}` : ""}`)
	}
}

/** One `bash -c` inside a fresh container, returning what it printed. */
const inImage = (program: string) => {
	const result = spawnSync(
		"docker",
		[
			"run",
			"--rm",
			...(process.env.MAPLE_SANDBOX_NO_CAPS ? [] : ["--cap-add", "SYS_ADMIN"]),
			"--entrypoint",
			"bash",
			IMAGE,
			"-c",
			program,
		],
		{ encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
	)
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? -1 }
}

/**
 * The real clone script, against a repository built inside the container.
 *
 * The credential is staged the way the Worker stages it — written to its own
 * file before the clone starts — so the assertions about where the token ends up
 * are about the real mechanism.
 */
const withCheckout = (commands: ReadonlyArray<string>) =>
	inImage(
		[
			"set -e",
			FIXTURE,
			`printf '%s' ${shellQuote(TOKEN)} > ${sandboxCredentialPath(SHA)}`,
			"set +e",
			"(",
			cloneScript(checkout),
			") > /tmp/clone.log 2>&1",
			`echo "CLONE_EXIT=$?"`,
			// Nothing below may run outside the checkout: without this a failed clone
			// leaves the shell in the fixture repository, where the same commands
			// happily succeed and every assertion passes for the wrong reason.
			`cd ${shellQuote(checkoutDir(SHA))} || { echo "NO_CHECKOUT=yes"; cat /tmp/clone.log; exit 90; }`,
			...commands,
		].join("\n"),
	)

console.log(`image ${IMAGE}, isolation expected: ${ISOLATION_EXPECTED}\n`)

// Docker stores the pinned image under its short name, so that is what the
// presence check has to ask for; `docker.io/…` finds nothing and re-pulls every run.
const LOCAL_TAG = IMAGE.replace(/^docker\.io\//, "")
if (execFileSync("docker", ["image", "ls", "-q", LOCAL_TAG], { encoding: "utf8" }).trim() === "") {
	console.log(`pulling ${IMAGE} (about a gigabyte, once)`)
	execFileSync("docker", ["pull", IMAGE], { stdio: "inherit" })
}

// The clone script is generated here but the commit exists only in the container,
// so one throwaway container builds the fixture and reports its hash. The build is
// deterministic, so every later container rebuilds the same commit — and if it
// ever stops being, the clone fails rather than checking out something else.
const probe = inImage(
	`set -e\n${FIXTURE}\ngit -C /work/src rev-parse HEAD\n${SECOND_COMMIT}\ngit -C /work/src rev-parse HEAD`,
)
const [SHA = "", SECOND_SHA = ""] = probe.stdout.trim().split("\n").slice(-2)
if (!/^[0-9a-f]{40}$/.test(SHA) || !/^[0-9a-f]{40}$/.test(SECOND_SHA)) {
	console.error(`could not build the fixture repository:\n${probe.stdout}\n${probe.stderr}`)
	process.exit(1)
}

const checkout = new SandboxCheckout({
	repository: "octo/shop",
	sha: SHA,
	// A repository inside the container, so the harness needs no network and no
	// real credential. Everything else about the clone is the production script.
	remoteUrl: "file:///origin.git",
	token: TOKEN,
})
const secondCheckout = new SandboxCheckout({ ...checkout, sha: SECOND_SHA })

console.log("the clone script")
{
	const dir = checkoutDir(SHA)
	const run = withCheckout([
		`echo "CHECKOUT_HEAD=$(git -C ${shellQuote(dir)} rev-parse --short HEAD 2>&1)"`,
		`echo "IS_CLONE=$(test -d ${shellQuote(`${dir}/.git`)} && echo yes || echo no)"`,
		`echo "HISTORY=$(git -C ${shellQuote(dir)} log --oneline 2>/dev/null | wc -l)"`,
		`echo "CREDENTIAL_LEFT=$(test -e ${sandboxCredentialPath(SHA)} && echo yes || echo no)"`,
		// Anywhere at all, not just where it was staged.
		`echo "TOKEN_ON_DISK=$(grep -rlF ${shellQuote(TOKEN)} / --exclude-dir=proc --exclude-dir=sys 2>/dev/null | head -n 3)"`,
		`echo "REMOTE=$(git -C ${shellQuote(dir)} remote get-url origin 2>&1)"`,
		`echo "HELPER=$(git -C ${shellQuote(dir)} config --get-all credential.helper 2>&1)"`,
		`echo "SCRATCH=$(ls -d ${shellQuote(SANDBOX_WORKSPACE_ROOT)}/.clone-*/ 2>/dev/null | wc -l)"`,
		"echo CLONE_LOG_START; cat /tmp/clone.log; echo CLONE_LOG_END",
	])
	const field = (name: string) =>
		new RegExp(`^${name}=(.*)$`, "m").exec(run.stdout)?.[1]?.trim() ?? "<missing>"
	const log = /CLONE_LOG_START\n([\s\S]*)\nCLONE_LOG_END/.exec(run.stdout)?.[1] ?? run.stderr

	check("the clone script exits 0", field("CLONE_EXIT") === "0", log)
	check("the commit is checked out as a real clone", field("IS_CLONE") === "yes", log)
	check("history came with it, which is the point of cloning", Number(field("HISTORY")) >= 1, log)
	check("the credential file is gone afterwards", field("CREDENTIAL_LEFT") === "no")
	check("the token is nowhere on disk", field("TOKEN_ON_DISK") === "", field("TOKEN_ON_DISK"))
	check("no credential helper is left in the checkout's config", field("HELPER") === "")
	check("no scratch directory is left behind", field("SCRATCH") === "0")
}

console.log("\nthe mirror")
{
	const second = checkoutDir(SECOND_SHA)
	const run = inImage(
		[
			"set -e",
			FIXTURE,
			"set +e",
			cloneFor(checkout, "FIRST"),
			SECOND_COMMIT,
			cloneFor(secondCheckout, "SECOND"),
			`echo "MIRROR_COUNT=$(ls -d ${shellQuote(SANDBOX_MIRROR_DIR)}* 2>/dev/null | wc -l)"`,
			`echo "SECOND_HEAD=$(git -C ${shellQuote(second)} rev-parse HEAD 2>&1)"`,
			`echo "SECOND_HISTORY=$(git -C ${shellQuote(second)} log --oneline 2>/dev/null | wc -l)"`,
			`echo "ORIGIN_MAIN=$(git -C ${shellQuote(second)} rev-parse origin/main 2>&1)"`,
			`echo "BORROWS=$(cat ${shellQuote(second)}/.git/objects/info/alternates 2>&1)"`,
			`echo "PINNED=$(git -C ${shellQuote(SANDBOX_MIRROR_DIR)} for-each-ref --format='%(refname)' refs/maple | wc -l)"`,
			`echo "MIRROR_GC=$(git -C ${shellQuote(SANDBOX_MIRROR_DIR)} config gc.auto)"`,
			`echo "MIRROR_REMOTES=$(git -C ${shellQuote(SANDBOX_MIRROR_DIR)} remote | wc -l)"`,
			`echo "TOKEN_ON_DISK=$(grep -rlF ${shellQuote(TOKEN)} / --exclude-dir=proc --exclude-dir=sys 2>/dev/null | head -n 3)"`,
			// The agent account reads history through the mirror it borrows objects from.
			`echo "AGENT_LOG=$(cd ${shellQuote(second)} && runuser -u ${SANDBOX_RUN_AS_USER} -- git log --oneline 2>&1 | wc -l)"`,
			`echo "AGENT_BLAME=$(cd ${shellQuote(second)} && runuser -u ${SANDBOX_RUN_AS_USER} -- git blame README.md 2>&1 | wc -l)"`,
			// The backup snapshot: a complete repository, and a hard-link copy rather than a second one.
			`( ${snapshotScript().replaceAll("\n", " && ")} ); echo "SNAPSHOT_EXIT=$?"`,
			`git -C ${shellQuote(SANDBOX_SNAPSHOT_DIR)} fsck --connectivity-only >/dev/null 2>&1; echo "SNAPSHOT_FSCK=$?"`,
			`echo "SNAPSHOT_HAS_SECOND=$(git -C ${shellQuote(SANDBOX_SNAPSHOT_DIR)} cat-file -t ${SECOND_SHA} 2>&1)"`,
			"echo LOGS_START; cat /tmp/clone-*.log; echo LOGS_END",
		].join("\n"),
	)
	const field = (name: string) =>
		new RegExp(`^${name}=(.*)$`, "m").exec(run.stdout)?.[1]?.trim() ?? "<missing>"
	const logs = /LOGS_START\n([\s\S]*)\nLOGS_END/.exec(run.stdout)?.[1] ?? `${run.stdout}\n${run.stderr}`

	check("the first commit clones through the mirror", field("FIRST_EXIT") === "0", logs)
	check("the next commit fetches into the same mirror", field("SECOND_EXIT") === "0", logs)
	check("there is exactly one mirror, and no scratch copy of it", field("MIRROR_COUNT") === "1")
	check("the next commit is checked out", field("SECOND_HEAD") === SECOND_SHA, field("SECOND_HEAD"))
	check("its checkout has the whole history", field("SECOND_HISTORY") === "2", field("SECOND_HISTORY"))
	check(
		"origin/main is there, as a full clone had it",
		field("ORIGIN_MAIN") === SECOND_SHA,
		field("ORIGIN_MAIN"),
	)
	check("the checkout borrows the mirror's objects", field("BORROWS").startsWith(SANDBOX_MIRROR_DIR))
	check("each reviewed commit is pinned in the mirror", field("PINNED") === "2", field("PINNED"))
	check("the mirror never garbage-collects what checkouts borrow", field("MIRROR_GC") === "0")
	check("the mirror keeps no remote, so no URL is stored", field("MIRROR_REMOTES") === "0")
	check("the token is nowhere on disk", field("TOKEN_ON_DISK") === "", field("TOKEN_ON_DISK"))
	check(
		`${SANDBOX_RUN_AS_USER} can read history through the mirror`,
		field("AGENT_LOG") === "2",
		field("AGENT_LOG"),
	)
	check(
		`${SANDBOX_RUN_AS_USER} can blame through the mirror`,
		field("AGENT_BLAME") === "2",
		field("AGENT_BLAME"),
	)
	check("the snapshot is taken", field("SNAPSHOT_EXIT") === "0", run.stderr)
	check("the snapshot is a complete repository", field("SNAPSHOT_FSCK") === "0", field("SNAPSHOT_FSCK"))
	check("the snapshot holds the latest commit", field("SNAPSHOT_HAS_SECOND") === "commit")
}

console.log("\na restored backup")
{
	// What `restoreBackup` leaves behind: the earlier mirror at the seed path, and no mirror.
	const run = inImage(
		[
			"set -e",
			FIXTURE,
			"set +e",
			cloneFor(checkout, "FIRST"),
			`( ${snapshotScript().replaceAll("\n", " && ")} )`,
			`mv ${shellQuote(SANDBOX_SNAPSHOT_DIR)} ${shellQuote(SANDBOX_SEED_DIR)}`,
			`touch ${shellQuote(SANDBOX_SEED_DIR)}/SEEDED`,
			`rm -rf ${shellQuote(SANDBOX_MIRROR_DIR)} ${shellQuote(SANDBOX_WORKSPACE_ROOT)}`,
			SECOND_COMMIT,
			cloneFor(secondCheckout, "RESTORED"),
			`echo "FROM_SEED=$(test -e ${shellQuote(SANDBOX_MIRROR_DIR)}/SEEDED && echo yes || echo no)"`,
			`echo "RESTORED_HEAD=$(git -C ${shellQuote(checkoutDir(SECOND_SHA))} rev-parse HEAD 2>&1)"`,
			`echo "RESTORED_HISTORY=$(git -C ${shellQuote(checkoutDir(SECOND_SHA))} log --oneline 2>/dev/null | wc -l)"`,
			"echo LOGS_START; cat /tmp/clone-*.log; echo LOGS_END",
		].join("\n"),
	)
	const field = (name: string) =>
		new RegExp(`^${name}=(.*)$`, "m").exec(run.stdout)?.[1]?.trim() ?? "<missing>"
	const logs = /LOGS_START\n([\s\S]*)\nLOGS_END/.exec(run.stdout)?.[1] ?? `${run.stdout}\n${run.stderr}`

	check("a clone after a restore succeeds", field("RESTORED_EXIT") === "0", logs)
	check("the mirror is built from the seed rather than from scratch", field("FROM_SEED") === "yes")
	check(
		"the new commit is fetched on top of it",
		field("RESTORED_HEAD") === SECOND_SHA,
		field("RESTORED_HEAD"),
	)
	check("history survives the restore", field("RESTORED_HISTORY") === "2", field("RESTORED_HISTORY"))
}

console.log("\nthe command wrapper")
{
	const dir = checkoutDir(SHA)
	const wrapped = (command: string, args: ReadonlyArray<string>, maxOutputBytes = 48 * 1024): string =>
		wrapCommand({ command, args, maxOutputBytes })

	const one = (label: string, program: string) => {
		const run = withCheckout([`echo "===${label}==="`, program, `echo "===${label}-END==="`])
		const body = new RegExp(`===${label}===\\n([\\s\\S]*?)\\n===${label}-END===`).exec(run.stdout)
		return body?.[1] ?? `${run.stdout}\n${run.stderr}`
	}

	const grep = one(
		"GREP",
		wrapped("git", ["--no-optional-locks", "grep", "--line-number", "-I", "-e", "card declined"]),
	)
	const grepTrailer = parseTrailer(grep)
	check(
		"git grep runs and matches",
		ISOLATION_EXPECTED === "unavailable" || grep.includes("src/checkout.ts:2:"),
		grep,
	)
	check(
		`the trailer reports a real exit code and isolation=${ISOLATION_EXPECTED}`,
		grepTrailer._tag === "Some" &&
			grepTrailer.value.trailer.exitCode === 0 &&
			grepTrailer.value.trailer.isolation === ISOLATION_EXPECTED,
		grep,
	)

	const whoami = one("WHOAMI", wrapped("id", ["-un"]))
	check(
		`commands run as ${SANDBOX_RUN_AS_USER}, not root`,
		whoami.includes(SANDBOX_RUN_AS_USER) || ISOLATION_EXPECTED === "unavailable",
		whoami,
	)

	const environment = one("ENV", wrapped("env", []))
	const names = environment
		.split("\n")
		.filter((line) => /^[A-Z_]+=/.test(line))
		.map((line) => line.slice(0, line.indexOf("=")))
		.sort()
	check(
		"the environment is exactly the contract's allowlist",
		ISOLATION_EXPECTED === "unavailable" ||
			names.join(",") === Object.keys(SANDBOX_COMMAND_ENV).sort().join(","),
		names.join(",") || environment,
	)

	const write = one("WRITE", wrapped("sh", ["-c", "echo x > README.md; echo status=$?"]))
	check(
		"the checkout cannot be written",
		ISOLATION_EXPECTED === "unavailable" || !write.includes("status=0"),
		write,
	)

	const egress = one("EGRESS", wrapped("sh", ["-c", "getent hosts github.com; echo status=$?"]))
	check(
		"there is no egress inside the namespace",
		ISOLATION_EXPECTED === "unavailable" || !egress.includes("status=0"),
		egress,
	)

	// 4 KiB of output against a 512-byte bound: the trailer must still carry the
	// true size, because that is what tells a caller its answer was cut.
	const big = one("BOUND", wrapped("sh", ["-c", "head -c 4096 /dev/zero | tr '\\0' 'x'"], 512))
	const bigTrailer = parseTrailer(big)
	check(
		"output is cut at the bound and the trailer keeps the true size",
		ISOLATION_EXPECTED === "unavailable" ||
			(bigTrailer._tag === "Some" &&
				bigTrailer.value.body.length <= 512 &&
				bigTrailer.value.trailer.stdoutBytes === 4096),
		big.slice(0, 200),
	)

	if (ISOLATION_EXPECTED === "unavailable") {
		const refused = parseTrailer(grep)
		check(
			"without the capability the command never runs at all",
			refused._tag === "Some" && refused.value.body === "" && refused.value.trailer.exitCode === 0,
			grep,
		)
	}
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
