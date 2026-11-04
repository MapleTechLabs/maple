import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SECURITY_AUDIT_LIMIT_DEFAULTS } from "@maple/backend/services/security-audit/limits"
import { Option, Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { lfsSkippedNote, parseRepoSize, REPO_SIZE_COMMAND, repoLimitViolations } from "./repo-size"

const limits = { ...SECURITY_AUDIT_LIMIT_DEFAULTS, maxCheckoutBytes: 10 * 1024 * 1024 }
const small = {
	commits: 900,
	files: 400,
	bytes: 4_000_000,
	lfsFiles: 0,
	lfsSourceFiles: 0,
	lfsSourceExamples: [],
}

describe("parseRepoSize", () => {
	it("reads the probe's five counts and example paths, and nothing else", () => {
		expect([
			parseRepoSize("1200 340 2048000 0 0\n"),
			parseRepoSize("1200 340 2048000 9 2\napps/a.ts\nlib/b.py\n"),
			parseRepoSize(""),
			parseRepoSize("fatal: not a git repository"),
			parseRepoSize("12 34 56 0"),
		]).toEqual([
			Option.some({ ...small, commits: 1200, files: 340, bytes: 2_048_000 }),
			Option.some({
				...small,
				commits: 1200,
				files: 340,
				bytes: 2_048_000,
				lfsFiles: 9,
				lfsSourceFiles: 2,
				lfsSourceExamples: ["apps/a.ts", "lib/b.py"],
			}),
			Option.none(),
			Option.none(),
			Option.none(),
		])
	})
})

describe("repoLimitViolations", () => {
	it("passes a repository within every limit", () => {
		expect(repoLimitViolations(small, limits)).toEqual([])
	})

	it("passes LFS media, which the audit skips, and refuses source kept in LFS", () => {
		expect([
			repoLimitViolations({ ...small, lfsFiles: 22_389 }, limits),
			repoLimitViolations(
				{ ...small, lfsFiles: 22_389, lfsSourceFiles: 1, lfsSourceExamples: ["src/gen.ts"] },
				limits,
			),
		]).toEqual([
			[],
			[
				"it stores 1 source files in Git LFS, whose content the checkout does not hold (limit 0; for example src/gen.ts)",
			],
		])
	})

	it("names each limit a repository is over", () => {
		expect(
			repoLimitViolations(
				{
					commits: 2_000_000,
					files: 150_000,
					bytes: 64 * 1024 * 1024,
					lfsFiles: 2,
					lfsSourceFiles: 2,
					lfsSourceExamples: ["a.go", "b.go"],
				},
				limits,
			),
		).toEqual([
			"its tracked files are 64 MiB, over the 10 MiB limit",
			"it tracks 150000 files, over the 100000 limit",
			"its history has 2000000 commits, over the 1000000 limit",
			"it stores 2 source files in Git LFS, whose content the checkout does not hold (limit 0; for example a.go, b.go)",
		])
	})
})

describe("lfsSkippedNote", () => {
	it("names nothing without LFS files, and the source among them when a limit lets it through", () => {
		expect([
			lfsSkippedNote(small),
			lfsSkippedNote({ ...small, lfsFiles: 12 }),
			lfsSkippedNote({ ...small, lfsFiles: 12, lfsSourceFiles: 1, lfsSourceExamples: ["a.ts"] }),
		]).toEqual([
			Option.none(),
			Option.some(
				"12 files stored in Git LFS were not audited: the checkout holds their pointers, not their content.",
			),
			Option.some(
				"12 files stored in Git LFS were not audited (1 of them source, for example a.ts): the checkout holds their pointers, not their content.",
			),
		])
	})
})

describe("the size probe", () => {
	it("fails when a git command in a pipeline fails, instead of reporting zero files", () => {
		// A `git` whose `ls-tree` fails, as a corrupt or half-cloned checkout's would.
		const bin = mkdtempSync(join(tmpdir(), "repo-size-probe-"))
		try {
			writeFileSync(
				join(bin, "git"),
				Arr.join(
					[
						"#!/bin/sh",
						'for arg in "$@"; do case "$arg" in',
						"  rev-list) echo 7; exit 0 ;;",
						"  ls-tree) echo 'fatal: not a tree object' >&2; exit 128 ;;",
						"  ls-files) exit 0 ;;",
						"esac; done",
					],
					"\n",
				),
			)
			chmodSync(join(bin, "git"), 0o755)
			const probe = spawnSync(REPO_SIZE_COMMAND.command, [...REPO_SIZE_COMMAND.args], {
				env: { PATH: `${bin}:/usr/bin:/bin` },
				encoding: "utf8",
			})
			expect([probe.status === 0, parseRepoSize(probe.stdout)]).toEqual([false, Option.none()])
		} finally {
			rmSync(bin, { recursive: true, force: true })
		}
	})

	it("counts LFS files and picks out the source among them in a real checkout", () => {
		const repo = mkdtempSync(join(tmpdir(), "repo-size-lfs-"))
		try {
			// No global or system config: a developer's git-lfs filter must not run here.
			const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }
			const git = (...args: ReadonlyArray<string>) =>
				spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env })
			git("init", "-q")
			writeFileSync(
				join(repo, ".gitattributes"),
				"*.png filter=lfs\n*.psd filter=lfs\n*.json filter=lfs\n*.pem filter=lfs\nsrc/Gen.TS filter=lfs\nsrc/we*.ts filter=lfs\n",
			)
			mkdirSync(join(repo, "src"))
			mkdirSync(join(repo, "assets"))
			mkdirSync(join(repo, "pkg"))
			mkdirSync(join(repo, "certs"))
			// LFS data JSON is skipped; an LFS manifest, key, uppercase .TS and a path git would
			// quote are source.
			const paths = [
				"assets/a.png",
				"assets/b.png",
				"assets/c.psd",
				"assets/data.json",
				"pkg/package.json",
				"certs/tls.pem",
				"src/Gen.TS",
				'src/we"ird.ts',
				"src/main.ts",
			]
			Arr.forEach(paths, (p) => writeFileSync(join(repo, p), "x"))
			git("add", "-A")
			git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init")
			const probe = spawnSync(REPO_SIZE_COMMAND.command, [...REPO_SIZE_COMMAND.args], {
				cwd: repo,
				encoding: "utf8",
				env,
			})
			expect(
				Option.map(parseRepoSize(probe.stdout), (size) => [
					size.files,
					size.lfsFiles,
					size.lfsSourceFiles,
					size.lfsSourceExamples,
				]),
			).toEqual(Option.some([10, 8, 4, ["certs/tls.pem", "pkg/package.json", "src/Gen.TS"]]))
		} finally {
			rmSync(repo, { recursive: true, force: true })
		}
	})

	it("refuses a commit with history but no files", () => {
		expect(repoLimitViolations({ ...small, commits: 7, files: 0, bytes: 0 }, limits)).toEqual([
			"its pinned commit listed no files although it has history, so its size could not be trusted",
		])
	})
})
