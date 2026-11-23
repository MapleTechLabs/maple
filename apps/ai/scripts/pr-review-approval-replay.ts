/**
 * Replays the automatic approval gate over a repository's past reviews.
 *
 *   bun run --cwd apps/ai review:approval-replay fetch octo/shop --limit 200 --out /tmp/approval
 *   bun run --cwd apps/ai review:approval-replay score --dir /tmp/approval [--risk medium]
 *
 * `fetch` caches, per pull request, the reviewer's last summary comment, its file listing and its
 * reviews (your `gh` login). `score` reads each comment's "Not auto-approved" reasons, which are
 * what the gate said when it ran, and recomputes the diff checks with this checkout's rules. The
 * model's own fields (risk, tests, verdict, findings, confidence) are taken as posted. A review that
 * read only the commits since the last one is listed as `needs whole-diff replay`, since a whole-diff
 * pass may rate it differently: replay those with `review:local`.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { Array as Arr, Schema, String as Str } from "effect"
import {
	PR_REVIEW_AUTO_APPROVE_MAX_CHANGED_LINES,
	PR_REVIEW_AUTO_APPROVE_MAX_FILES,
	prReviewDiffSignals,
} from "@maple/domain/http"

const BOT = "maple-review-bot[bot]"

const CachedFile = Schema.Struct({
	path: Schema.String,
	previousPath: Schema.NullOr(Schema.String),
	additions: Schema.Number,
	deletions: Schema.Number,
	hasPatch: Schema.Boolean,
	patchLines: Schema.Number,
	patchChars: Schema.Number,
})
const decodeFiles = Schema.decodeSync(Schema.fromJsonString(Schema.Array(CachedFile)))
const decodeComment = Schema.decodeSync(
	Schema.fromJsonString(Schema.NullOr(Schema.Struct({ body: Schema.String }))),
)
const decodeReviews = Schema.decodeSync(
	Schema.fromJsonString(Schema.Array(Schema.Struct({ state: Schema.String }))),
)
const decodeNumbers = Schema.decodeSync(Schema.fromJsonString(Schema.Array(Schema.Number)))
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: "\t" }))

const gh = (args: ReadonlyArray<string>): string => {
	const proc = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
	if (proc.status !== 0) throw new Error(`gh ${Arr.join(args, " ")}: ${proc.stderr}`)
	return proc.stdout
}

const flag = (argv: ReadonlyArray<string>, name: string): string | undefined => {
	const at = argv.indexOf(`--${name}`)
	return at === -1 ? undefined : argv[at + 1]
}

const fetchAll = (argv: ReadonlyArray<string>) => {
	const repo = argv[0]
	const out = flag(argv, "out")
	if (repo === undefined || out === undefined) {
		console.error("fetch needs <owner/repo> --out <dir>")
		process.exit(2)
	}
	const limit = flag(argv, "limit") ?? "200"
	const numbers = decodeNumbers(
		gh([
			"pr",
			"list",
			"-R",
			repo,
			"--state",
			"all",
			"-L",
			limit,
			"--json",
			"number,isDraft",
			"--jq",
			"[.[]|select(.isDraft==false)|.number]",
		]),
	)
	mkdirSync(out, { recursive: true })
	for (const n of numbers) {
		const dir = join(out, String(n))
		if (existsSync(join(dir, "files.json"))) continue
		// One body per line across every page; the summary comment carries the review marker.
		const bodies = Arr.filter(
			Str.split("\n")(
				gh([
					"api",
					`repos/${repo}/issues/${n}/comments`,
					"--paginate",
					"--jq",
					`.[]|select(.user.login=="${BOT}" and (.body|contains("maple-pr-review")))|.body|@json`,
				]),
			),
			Str.isNonEmpty,
		)
		const last = bodies.at(-1)
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, "comment.json"), last === undefined ? "null" : `{"body":${last}}`)
		writeFileSync(
			join(dir, "reviews.json"),
			gh([
				"api",
				`repos/${repo}/pulls/${n}/reviews`,
				"--jq",
				`[.[]|select(.user.login=="${BOT}")|{state}]`,
			]),
		)
		const files = gh([
			"api",
			`repos/${repo}/pulls/${n}/files`,
			"--paginate",
			"--jq",
			'.[]|{path:.filename,previousPath:(.previous_filename//null),additions,deletions,hasPatch:(.patch!=null),patchLines:((.patch//"")|split("\\n")|length),patchChars:((.patch//"")|length)}',
		])
		writeFileSync(
			join(dir, "files.json"),
			`[${Arr.join(Arr.filter(Str.split("\n")(files), Str.isNonEmpty), ",")}]`,
		)
		console.error(`#${n}`)
	}
}

/** The posted reasons, by the gate's own wording. */
const REASONS: ReadonlyArray<readonly [string, RegExp]> = [
	["not_whole_diff", /^the review read only the commits/],
	["sensitive_paths", /^the diff touches /],
	["too_large", /^the diff changes \d+ (lines|files)/],
	["unreviewed_kinds", /^some files are of a kind/],
	["patchless", /^some files have no patch/],
	["truncated_patch", /^some files have a patch longer/],
	["truncated_listing", /^the diff has more files/],
	["risk:medium", /^the risk is medium/],
	["risk", /^the risk is /],
	["tests", /^tests are /],
	["verdict", /^the verdict is /],
	["findings", /^a warning or critical finding is open/],
	["confidence", /^confidence is /],
	["merge_steps", /steps? before merge (is|are) open/],
]
/** Refusals this checkout recomputes from the file listing instead of taking from the comment. */
const RECOMPUTED = new Set([
	"sensitive_paths",
	"too_large",
	"unreviewed_kinds",
	"patchless",
	"truncated_patch",
])

/** A patch of `lines` context lines totalling about `chars` characters. */
const standInPatch = (lines: number, chars: number): string => {
	const count = Math.max(1, lines)
	const line = ` ${"x".repeat(Math.max(0, Math.floor(chars / count) - 2))}`
	return Arr.join(
		Arr.makeBy(count, () => line),
		"\n",
	)
}

const reasonsOf = (body: string): ReadonlyArray<string> | undefined => {
	const match = /Not auto-approved: ([^<]*)/.exec(body)
	if (match === null) return /\*\*Confidence \d+\/10\*\*/.test(body) ? [] : undefined
	return Arr.map(Str.split(" · ")(Str.trim(match[1] ?? "")), (reason) => {
		const known = REASONS.find(([, pattern]) => pattern.test(reason))
		return known?.[0] ?? `other: ${reason}`
	})
}

const score = (argv: ReadonlyArray<string>) => {
	const dir = resolve(flag(argv, "dir") ?? ".")
	// What the replay may loosen besides the diff checks, for "what if" runs.
	const allowMediumRisk = flag(argv, "risk") === "medium"
	const rows = Arr.flatMap(readdirSync(dir), (entry) => {
		const base = join(dir, entry)
		if (!existsSync(join(base, "files.json"))) return []
		const comment = decodeComment(readFileSync(join(base, "comment.json"), "utf8"))
		const posted = comment === null ? undefined : reasonsOf(comment.body)
		if (posted === undefined) return []
		const approved = Arr.some(
			decodeReviews(readFileSync(join(base, "reviews.json"), "utf8")),
			(r) => r.state === "APPROVED",
		)
		const files = decodeFiles(readFileSync(join(base, "files.json"), "utf8"))
		const signals = prReviewDiffSignals({
			files: Arr.map(files, (file) => ({
				path: file.path,
				previousPath: file.previousPath,
				additions: file.additions,
				deletions: file.deletions,
				status: "modified" as const,
				// Only its size matters here: a stand-in of the same lines and characters.
				patch: file.hasPatch ? standInPatch(file.patchLines, file.patchChars) : null,
			})),
			truncated: false,
			isIgnored: () => false,
		})
		const recomputed = [
			...(signals.sensitivePaths.length > 0 ? ["sensitive_paths"] : []),
			...(signals.changedLines > PR_REVIEW_AUTO_APPROVE_MAX_CHANGED_LINES ||
			signals.changedFiles > PR_REVIEW_AUTO_APPROVE_MAX_FILES
				? ["too_large"]
				: []),
			...(signals.unreviewedKindFiles > 0 ? ["unreviewed_kinds"] : []),
			...(Arr.some(files, (file) => !file.hasPatch) ? ["patchless"] : []),
			...(signals.truncatedPatchFiles > 0 ? ["truncated_patch"] : []),
		]
		const model = Arr.filter(
			posted,
			(reason) =>
				!RECOMPUTED.has(reason) &&
				reason !== "not_whole_diff" &&
				!(allowMediumRisk && reason === "risk:medium"),
		)
		const now = [...recomputed, ...model]
		const wholeDiffPending = posted.includes("not_whole_diff") && recomputed.length === 0
		const outcome = approved
			? "approved"
			: now.length > 0
				? "refused"
				: wholeDiffPending
					? "needs whole-diff replay"
					: "newly approved"
		return [
			{
				number: Number(entry),
				approved,
				posted,
				now,
				outcome,
				sensitive: signals.sensitivePaths,
				lines: signals.changedLines,
			},
		]
	})
	const tally = (key: (row: (typeof rows)[number]) => string) =>
		Arr.reduce(rows, new Map<string, number>(), (acc, row) =>
			acc.set(key(row), (acc.get(key(row)) ?? 0) + 1),
		)
	console.log(`${rows.length} reviews with a verdict`)
	console.table(Object.fromEntries(tally((row) => row.outcome)))
	const onlyBlocker = new Map<string, number>()
	for (const row of rows)
		if (row.now.length === 1)
			onlyBlocker.set(row.now[0] ?? "", (onlyBlocker.get(row.now[0] ?? "") ?? 0) + 1)
	console.log("refusals that stand alone now:")
	console.table(Object.fromEntries(onlyBlocker))
	for (const row of rows)
		if (row.outcome === "newly approved" || row.outcome === "needs whole-diff replay")
			console.log(`#${row.number}\t${row.outcome}\twas: ${Arr.join(row.posted, ", ")}`)
	writeFileSync(join(dir, "replay.json"), encodeJson(rows))
}

if (import.meta.main) {
	const [command, ...rest] = process.argv.slice(2)
	if (command === "fetch") fetchAll(rest)
	else if (command === "score") score(rest)
	else {
		console.error("usage: fetch <owner/repo> --out <dir> [--limit n] | score --dir <dir> [--risk medium]")
		process.exit(2)
	}
}
