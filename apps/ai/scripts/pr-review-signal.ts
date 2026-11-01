/**
 * Snapshot the review comments Maple published on real pull requests, as cases for
 * `review-signal.corpus.test.ts`: how much each review showed a reader, and what the next push's
 * review found after it.
 *
 *   bun run --cwd apps/ai review:signal MapleTechLabs/maple 1915 1969
 *
 * Reads every pull request in the range through your `gh` login and writes one case per pull request
 * that has at least one review summary. Only the review App's summaries and the inline notes the
 * reviews opened are kept; replies, other bots and people are left out. Re-running overwrites the
 * cases; the labels in `labels.json` are left alone.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
	isReviewSummary,
	ReviewSignalCase,
	snapshotComment,
} from "@maple/backend/services/pr-review/review-signal-corpus"
import { Option, Schema } from "effect"
import { run } from "./pr-review-local"

const CORPUS_DIR = fileURLToPath(
	new URL("../../../packages/backend/src/services/pr-review/__fixtures__/review-signal/", import.meta.url),
)
const encodeCase = Schema.encodeSync(ReviewSignalCase)

const Comment = Schema.Struct({
	body: Schema.optionalKey(Schema.NullOr(Schema.String)),
	created_at: Schema.String,
	user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
	in_reply_to_id: Schema.optionalKey(Schema.NullOr(Schema.Number)),
})
const decodeComments = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Comment)))
const PullRequest = Schema.Struct({ title: Schema.String })
const decodePullRequest = Schema.decodeUnknownOption(Schema.fromJsonString(PullRequest))

/** The review App's login on GitHub; its summaries and inline notes are the corpus. */
const REVIEWER = "maple-review-bot[bot]"

/** Every page of a list endpoint as one array: `--paginate --slurp` gives an array of pages. */
const list = (path: string) => {
	const result = run(["gh", "api", "--paginate", "--slurp", path])
	if (!result.ok) return []
	return Option.getOrElse(decodeComments(JSON.stringify(JSON.parse(result.stdout).flat())), () => [])
}

const snapshot = (owner: string, repo: string, number: number): boolean => {
	const pr = run(["gh", "api", `repos/${owner}/${repo}/pulls/${number}`])
	const title = pr.ok
		? Option.match(decodePullRequest(pr.stdout), { onNone: () => "", onSome: (item) => item.title })
		: ""
	const byReviewer = (comments: ReturnType<typeof list>) =>
		comments
			.filter((comment) => comment.user?.login === REVIEWER)
			.sort((a, b) => a.created_at.localeCompare(b.created_at))
	const summaries = byReviewer(
		list(`repos/${owner}/${repo}/issues/${number}/comments?per_page=100`),
	).filter((comment) => isReviewSummary(comment.body ?? ""))
	if (summaries.length === 0) return false
	const inline = byReviewer(list(`repos/${owner}/${repo}/pulls/${number}/comments?per_page=100`)).filter(
		(comment) => comment.in_reply_to_id === undefined || comment.in_reply_to_id === null,
	)
	const item: ReviewSignalCase = {
		id: `${repo}-${number}`,
		repo: `${owner}/${repo}`,
		number,
		title,
		summaries: summaries.map((comment) => snapshotComment(comment.created_at, comment.body ?? "")),
		inline: inline.map((comment) => snapshotComment(comment.created_at, comment.body ?? "")),
	}
	if (!existsSync(CORPUS_DIR)) mkdirSync(CORPUS_DIR, { recursive: true })
	// Generated, so compact: the labels are the file people read and edit.
	writeFileSync(join(CORPUS_DIR, `${item.id}.json`), `${JSON.stringify(encodeCase(item))}\n`)
	console.log(`${item.id}: ${summaries.length} reviews, ${inline.length} inline notes · ${title}`)
	return true
}

export const snapshotRange = (argv: ReadonlyArray<string>) => {
	const [slug = "", from = "", to = from] = argv
	const [owner, repo] = slug.split("/")
	const first = Number(from)
	const last = Number(to)
	if (
		owner === undefined ||
		repo === undefined ||
		!Number.isInteger(first) ||
		!Number.isInteger(last) ||
		last < first
	) {
		console.error("usage: review:signal <owner/repo> <first pull request> [last pull request]")
		return process.exit(1)
	}
	const written = Array.from({ length: last - first + 1 }, (_, i) => first + i).filter((number) =>
		snapshot(owner, repo, number),
	)
	console.log(`${written.length} cases in ${CORPUS_DIR}`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	snapshotRange(process.argv.slice(2))
}
