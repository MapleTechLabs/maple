/**
 * The "before merge" checklist: what has to happen outside the diff before a change ships.
 *
 * Three pure steps, so every decision is testable and lands in the trace:
 * 1. `detectMergeSteps` reads the changed files: names the diff starts reading (secrets, env vars,
 *    CI secrets) and files that imply a step (migrations, warehouse schema, deployment config).
 * 2. `searchVerdict` rules on each name from a code search of the default branch: `new`, `exists`
 *    (already read there, nothing to add) or `unverified` (no search ran, or it failed).
 * 3. `buildChecklist` lists new and unverified names, file steps and the reviewer's steps, and
 *    traces what it dropped and why. The service only does the reads between them.
 */
import {
	mergeStepKey,
	PrReviewMergeStep,
	type PrReviewMergeStepStatus,
	type PullRequestFile,
} from "@maple/domain/http"
import { Array as Arr, HashSet, Option, Order, Result, Schema } from "effect"

/** A name the diff starts reading, before the service checks the base does not already. */
export interface MergeStepName {
	readonly name: string
	readonly kind: "secret" | "env"
	/** Read from a CI workflow's `secrets.`/`vars.` context rather than the runtime environment. */
	readonly ci: boolean
	readonly path: string
	readonly line: number
}

export interface DetectedMergeSteps {
	/** Candidates the base may already read; listed only once a search says it does not. */
	readonly names: ReadonlyArray<MergeStepName>
	/** Steps that follow from a file alone. */
	readonly steps: ReadonlyArray<PrReviewMergeStep>
}

const NAME = "([A-Z][A-Z0-9_]{2,})"

/** Reads of the runtime environment across the languages a reviewed repository may be in. */
const ENV_READS = [
	new RegExp(`process\\.env\\.${NAME}`, "g"),
	new RegExp(`process\\.env\\[["'\`]${NAME}["'\`]\\]`, "g"),
	new RegExp(`(?:Bun|import\\.meta)\\.env\\.${NAME}`, "g"),
	new RegExp(`Deno\\.env\\.get\\(\\s*["']${NAME}["']`, "g"),
	new RegExp(`os\\.(?:environ(?:\\.get)?|getenv)\\s*[[(]\\s*["']${NAME}["']`, "g"),
	new RegExp(`os\\.(?:Getenv|LookupEnv)\\(\\s*"${NAME}"`, "g"),
	new RegExp(`env::var\\(\\s*"${NAME}"`, "g"),
	new RegExp(`ENV\\.fetch\\(\\s*["']${NAME}["']|ENV\\[["']${NAME}["']\\]`, "g"),
]

/** A config helper given the name as a literal: `Config.redacted("X")`, `requiredSecret("X")`. */
const CONFIG_CALL = new RegExp(`([A-Za-z_$][\\w$.]*)\\s*\\(\\s*["'\`]${NAME}["'\`]`, "g")
const CONFIG_CALLEE = /config|env|secret|redacted|plain|setting/i
const SECRET_CALLEE = /secret|redacted/i

/**
 * A name held in a constant named for what it is, then read through the constant:
 * `CLIENT_SECRET_CONFIG = "MAPLE_SLACK_CLIENT_SECRET"`. The constant's name says it is config; a
 * bare `const LABEL = "SOME_TEXT"` is not.
 */
const NAMED_CONSTANT = new RegExp(
	`\\b([A-Z][A-Z0-9_]*_(?:CONFIG|ENV|ENV_VAR|VAR|SECRET|TOKEN|KEY)(?:_NAME)?)\\s*(?::\\s*[\\w<>]+\\s*)?=\\s*["'\`]${NAME}["'\`]`,
	"g",
)

const CI_READ = new RegExp(`\\$\\{\\{[^}]*\\b(secrets|vars)\\.${NAME}`, "g")
const DOTENV_LINE = new RegExp(`^\\s*(?:export\\s+)?${NAME}\\s*=`)

/** A name that reads as a credential; a publishable or public key is configuration. */
const looksSecret = (name: string) =>
	/SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|_KEY$|_DSN$|SIGNING/.test(name) &&
	!/PUBLISHABLE|PUBLIC/.test(name)

/** Names every runtime or CI provides; never something to add. */
const PROVIDED = new Set([
	"NODE_ENV",
	"CI",
	"HOME",
	"PATH",
	"PWD",
	"TZ",
	"DEBUG",
	"PORT",
	"GITHUB_TOKEN",
	"GITHUB_SHA",
	"GITHUB_REF",
	"GITHUB_REPOSITORY",
	"GITHUB_RUN_ID",
	"GITHUB_WORKSPACE",
	"RUNNER_TEMP",
	"DEV",
	"PROD",
	"MODE",
	"SSR",
	"BASE_URL",
])

const TEST_PATH =
	/(^|\/)(__tests__|__snapshots__|__fixtures__|tests?|fixtures?|e2e|testdata|mocks?)\/|\.(test|spec|eval|bench)\.[a-z]+$/i
const DOC_PATH = /\.(md|mdx|txt|rst)$/i
/** Code a developer runs by hand; what it reads is set on their machine, not in a deployment. */
const LOCAL_PATH = /(^|\/)(scripts?|examples?|benchmarks?|evals?)\//i
const DOTENV_TEMPLATE =
	/(^|\/)\.(env|dev\.vars)(\.[\w-]+)?\.(example|sample|template|dist)$|(^|\/)env\.example$/i
const WORKFLOW = /(^|\/)\.github\/(workflows|actions)\/.+\.ya?ml$/i
const MIGRATION_DIR =
	/(^|\/)(migrations?|drizzle|alembic\/versions|db\/migrate|prisma\/migrations|supabase\/migrations)\//i
const MIGRATION_FILE = /\.(sql|ts|js|mjs|py|rb)$/i
const WAREHOUSE = /\.(datasource|pipe)$|(^|\/)datasources\.ts$|(^|\/)clickhouse\/.+\.sql$/i
const INFRA =
	/(^|\/)(wrangler\.(toml|jsonc?)|alchemy\.run\.ts|fly\.toml|vercel\.json|render\.ya?ml|serverless\.ya?ml|docker-compose[\w.-]*\.ya?ml|Dockerfile[\w.-]*)$|\.(tf|tfvars)$/

/** Whether detection reads names off a file's added lines: not tests, docs or hand-run scripts. */
export const readsNamesIn = (path: string): boolean =>
	!TEST_PATH.test(path) && !DOC_PATH.test(path) && !LOCAL_PATH.test(path)

/** One changed line of a unified diff. */
export interface PatchLine {
	readonly kind: "added" | "removed"
	readonly text: string
	/** The line in the new file; for a removed line, the new-file line it sat before. */
	readonly line: number
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)/

/**
 * A unified diff's added and removed lines, each with its line in the new file. The line counter
 * is the accumulator: a hunk header resets it, added and context lines advance it, and removed
 * lines and `\ No newline` markers leave it.
 */
export const patchLines = (patch: string): ReadonlyArray<PatchLine> =>
	Arr.getSomes(
		Arr.mapAccum(patch.split("\n"), 0, (line, raw): readonly [number, Option.Option<PatchLine>] => {
			const hunk = HUNK_HEADER.exec(raw)
			if (hunk !== null) return [Number(hunk[1]), Option.none()]
			if (raw.startsWith("+"))
				return [line + 1, Option.some({ kind: "added", text: raw.slice(1), line })]
			if (raw.startsWith("-")) return [line, Option.some({ kind: "removed", text: raw.slice(1), line })]
			return [raw.startsWith("\\") ? line : line + 1, Option.none()]
		})[1],
	)

/** A diff's lines split by kind. */
const splitPatch = (patch: string | null) => {
	const [added, removed] = Arr.partition(patch === null ? [] : patchLines(patch), (line) =>
		line.kind === "added" ? Result.succeed(line) : Result.fail(line.text),
	)
	return { added, removed }
}

/** Every environment name a line reads, and whether the way it reads it says it is a secret. */
const namesRead = (text: string): Array<{ name: string; secret: boolean }> => {
	const found: Array<{ name: string; secret: boolean }> = []
	for (const pattern of ENV_READS) {
		for (const match of text.matchAll(pattern)) {
			const name = match.slice(1).find((group) => group !== undefined)
			if (name !== undefined) found.push({ name, secret: false })
		}
	}
	for (const [, constant = "", name] of text.matchAll(NAMED_CONSTANT)) {
		if (name !== undefined && name.includes("_"))
			found.push({ name, secret: /SECRET|TOKEN/.test(constant) })
	}
	for (const match of text.matchAll(CONFIG_CALL)) {
		const [, callee = "", name] = match
		if (name !== undefined && CONFIG_CALLEE.test(callee))
			found.push({ name, secret: SECRET_CALLEE.test(callee) })
	}
	return found
}

/**
 * The diff's checklist candidates. A name counts only on an added line of a source file, and not
 * when any removed line in the pull request still mentions it: a moved read is not a new one.
 */
export const detectMergeSteps = (files: ReadonlyArray<PullRequestFile>): DetectedMergeSteps => {
	const names = new Map<string, MergeStepName>()
	const removedText: Array<string> = []
	const steps: Array<PrReviewMergeStep> = []

	for (const file of files) {
		if (file.status === "removed") continue
		const { path } = file
		const { added, removed } = splitPatch(file.patch)
		removedText.push(...removed)

		if (MIGRATION_DIR.test(path) && MIGRATION_FILE.test(path) && file.status === "added") {
			steps.push(
				new PrReviewMergeStep({
					kind: "migration",
					title: "Check it is safe on production data and with the code still deployed",
					subject: path,
					path,
					source: "diff",
				}),
			)
			continue
		}
		if (WAREHOUSE.test(path)) {
			steps.push(
				new PrReviewMergeStep({
					kind: "warehouse",
					title: "Deploy the schema before the code that reads it",
					subject: path,
					path,
					source: "diff",
				}),
			)
		} else if (INFRA.test(path)) {
			steps.push(
				new PrReviewMergeStep({
					kind: "infra",
					title: "Check every environment has what this config now expects",
					subject: path,
					path,
					source: "diff",
				}),
			)
		}

		if (!readsNamesIn(path)) continue
		const remember = (candidate: MergeStepName) => {
			if (PROVIDED.has(candidate.name) || names.has(candidate.name)) return
			names.set(candidate.name, candidate)
		}
		for (const { text, line } of added) {
			if (DOTENV_TEMPLATE.test(path)) {
				const name = DOTENV_LINE.exec(text)?.[1]
				if (name !== undefined)
					remember({ name, kind: looksSecret(name) ? "secret" : "env", ci: false, path, line })
				continue
			}
			if (WORKFLOW.test(path)) {
				for (const [, context, name] of text.matchAll(CI_READ)) {
					if (name === undefined) continue
					remember({ name, kind: context === "secrets" ? "secret" : "env", ci: true, path, line })
				}
				continue
			}
			for (const { name, secret } of namesRead(text)) {
				remember({
					name,
					kind: secret || looksSecret(name) ? "secret" : "env",
					ci: false,
					path,
					line,
				})
			}
		}
	}

	const removed = removedText.join("\n")
	return {
		names: [...names.values()].filter(
			(candidate) => !new RegExp(`\\b${candidate.name}\\b`).test(removed),
		),
		steps,
	}
}

/** Whether a name was already read on the default branch before this pull request. */
export const NameVerdictSchema = Schema.Literals(["new", "exists", "unverified"])
export type NameVerdict = Schema.Schema.Type<typeof NameVerdictSchema>

/** What a verdict is read from: a search hit's matched text. */
export interface SearchHit {
	readonly snippets: ReadonlyArray<string>
}

/**
 * A name's verdict from a code search of the default branch. Search matches tokens, so a hit on
 * `STRIPE_KEY_ID` comes back for `STRIPE_KEY`: a hit counts only when a snippet holds the name as
 * a whole word, or carries no text to check.
 */
export const searchVerdict = (name: string, hits: ReadonlyArray<SearchHit>): NameVerdict => {
	const whole = new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`)
	return hits.some((hit) => hit.snippets.length === 0 || hit.snippets.some((text) => whole.test(text)))
		? "exists"
		: "new"
}

const nameStep = (candidate: MergeStepName): PrReviewMergeStep => {
	const name = `\`${candidate.name}\``
	const title = candidate.ci
		? `Add ${name} to the repository's CI ${candidate.kind === "secret" ? "secrets" : "variables"}`
		: candidate.kind === "secret"
			? `Add secret ${name} to every environment`
			: `Set ${name} in every environment, or confirm its default`
	return new PrReviewMergeStep({
		kind: candidate.kind,
		title,
		subject: candidate.name,
		path: candidate.path,
		line: candidate.line,
		source: "diff",
	})
}

/** Most likely to be forgotten first. */
const KIND_ORDER = { secret: 0, env: 1, migration: 2, warehouse: 3, infra: 4, manual: 5 } as const
const MAX_STEPS = 15

/** Every decision `buildChecklist` made, for the span and the log. */
export interface ChecklistTrace {
	readonly names: ReadonlyArray<{ readonly name: string; readonly verdict: NameVerdict }>
	readonly fileSteps: number
	readonly reviewerSteps: number
	/** Subjects whose diff step a reviewer step replaced. */
	readonly replaced: ReadonlyArray<string>
	/** Subjects under the repository's ignored paths. */
	readonly ignored: ReadonlyArray<string>
	/** Steps past the cap. */
	readonly cut: number
}

export interface Checklist {
	readonly steps: ReadonlyArray<PrReviewMergeStep>
	readonly trace: ChecklistTrace
}

export const NO_DETECTED_STEPS: DetectedMergeSteps = { names: [], steps: [] }

/**
 * The checklist from the diff's candidates, each name's verdict (absent reads as `unverified`)
 * and the reviewer's steps. A name already on the default branch is dropped; an unverified one is
 * kept, since a missed secret costs more than a redundant line. A reviewer step that names a diff
 * step's subject replaces it: the reviewer read the repository's conventions and says where.
 */
export const buildChecklist = (input: {
	readonly detected: DetectedMergeSteps
	readonly verdicts: ReadonlyMap<string, NameVerdict>
	readonly reviewer: ReadonlyArray<PrReviewMergeStep>
	readonly isIgnored: (path: string) => boolean
}): Checklist => {
	const names = input.detected.names.map((candidate) => ({
		candidate,
		verdict: input.verdicts.get(candidate.name) ?? ("unverified" as const),
	}))
	const fromDiff = [
		...names.filter(({ verdict }) => verdict !== "exists").map(({ candidate }) => nameStep(candidate)),
		...input.detected.steps,
	]
	const ignored = fromDiff.filter((step) => step.path !== undefined && input.isIgnored(step.path))
	const replaced = fromDiff.filter(
		(step) =>
			!ignored.includes(step) &&
			input.reviewer.some((other) => step.subject !== undefined && other.title.includes(step.subject)),
	)
	const kept = fromDiff.filter((step) => !ignored.includes(step) && !replaced.includes(step))
	// A reviewer step that replaces a diff step takes over its identity, so a tick on either
	// wording carries across pushes and the comment still labels it a secret, not a manual step.
	const reviewer = input.reviewer.map((step) => {
		const named = replaced.find(
			(other) => other.subject !== undefined && step.title.includes(other.subject),
		)
		return named === undefined
			? step
			: new PrReviewMergeStep({ ...named, title: step.title, source: "reviewer" })
	})
	const all = [...kept, ...reviewer].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
	const subjects = (steps: ReadonlyArray<PrReviewMergeStep>) =>
		steps.map((step) => step.subject ?? step.title)
	return {
		steps: all.slice(0, MAX_STEPS),
		trace: {
			names: names.map(({ candidate, verdict }) => ({ name: candidate.name, verdict })),
			fileSteps: input.detected.steps.length,
			reviewerSteps: input.reviewer.length,
			replaced: subjects(replaced),
			ignored: subjects(ignored),
			cut: Math.max(0, all.length - MAX_STEPS),
		},
	}
}

/**
 * The trace as span attributes under `maple.pr_review.checklist.*`. `status` says whether the diff
 * was read: `unread` means the list holds the reviewer's steps alone.
 */
export const checklistAttributes = (
	status: "read" | "unread",
	checklist: Checklist,
): Record<string, string | number> => {
	const { trace } = checklist
	const named = (verdict: NameVerdict) =>
		trace.names
			.filter((item) => item.verdict === verdict)
			.map((item) => item.name)
			.join(",")
	return {
		"maple.pr_review.checklist.status": status,
		"maple.pr_review.checklist.steps": checklist.steps.length,
		"maple.pr_review.checklist.names_new": named("new"),
		"maple.pr_review.checklist.names_exists": named("exists"),
		"maple.pr_review.checklist.names_unverified": named("unverified"),
		"maple.pr_review.checklist.file_steps": trace.fileSteps,
		"maple.pr_review.checklist.reviewer_steps": trace.reviewerSteps,
		"maple.pr_review.checklist.replaced": trace.replaced.join(","),
		"maple.pr_review.checklist.ignored": trace.ignored.join(","),
		"maple.pr_review.checklist.cut": trace.cut,
	}
}

/** A step as stored for the pull request, from earlier reviews. */
export interface StoredMergeStep {
	readonly key: string
	readonly kind: PrReviewMergeStep["kind"]
	readonly title: string
	readonly status: PrReviewMergeStepStatus
	readonly doneBy: string | null
}

export interface ReconciledMergeSteps {
	/** This review's steps, keyed, with the ticks earlier comments carried. */
	readonly steps: ReadonlyArray<PrReviewMergeStep>
	/** Each step to write, by key; an obsolete step that is back opens again. */
	readonly upserts: ReadonlyArray<{ readonly key: string; readonly step: PrReviewMergeStep }>
	/** Open steps this head no longer produces. */
	readonly obsolete: ReadonlyArray<string>
}

/** Words that say nothing about which step it is. */
const FILLER = HashSet.fromIterable(
	"the and for add run set with from into this that every all environment environments before after merge make sure check".split(
		" ",
	),
)

/** A title's telling words, plural folded: `stores` and `store` are one word. */
const words = (text: string): ReadonlyArray<string> =>
	Arr.dedupe(
		Arr.filter(
			Arr.map(text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [], (word) =>
				word.replace(/(?<=[a-z]{3})s$/, ""),
			),
			(word) => !HashSet.has(FILLER, word),
		),
	)

/**
 * How much of the shorter title the longer one repeats. A reviewer rewording a manual step between
 * pushes keeps its nouns; two different steps on the same thing share only that thing.
 */
const similarity = (a: string, b: string): number => {
	const left = words(a)
	const right = words(b)
	const smaller = Math.min(left.length, right.length)
	return smaller === 0 ? 0 : Arr.intersection(left, right).length / smaller
}

const MIN_SIMILARITY = 0.6
const byScoreDescending = Order.flip(
	Order.mapInput(Order.Number, (match: { readonly score: number }) => match.score),
)

/**
 * This review's steps against the pull request's stored ones. A step keeps its stored key, and
 * shows done when it was ticked. A manual step without a subject is matched to a stored manual
 * step by wording when its key is new, so a reworded step keeps its tick. A stored step this head
 * no longer produces becomes obsolete, unless it was done: a tick is never taken back.
 */
export const reconcileMergeSteps = (
	steps: ReadonlyArray<PrReviewMergeStep>,
	stored: ReadonlyArray<StoredMergeStep>,
): ReconciledMergeSteps => {
	const byKey = new Map(Arr.map(stored, (row) => [row.key, row] as const))
	const ownKeys = HashSet.fromIterable(Arr.map(steps, mergeStepKey))
	// Stored manual steps no step of this review names by key: what a reworded step may match.
	const rewordable = Arr.filter(
		stored,
		(row) => row.kind === "manual" && row.status !== "obsolete" && !HashSet.has(ownKeys, row.key),
	)
	// The keys claimed so far ride along, so two reworded steps never take the same stored row.
	const [claimed, keyed] = Arr.mapAccum(steps, HashSet.empty<string>(), (taken, step) => {
		const own = mergeStepKey(step)
		const key =
			byKey.has(own) || step.subject !== undefined || step.kind !== "manual"
				? own
				: Option.match(
						Arr.head(
							Arr.sort(
								Arr.filter(
									Arr.map(rewordable, (row) => ({
										row,
										score: similarity(row.title, step.title),
									})),
									({ row, score }) =>
										score >= MIN_SIMILARITY && !HashSet.has(taken, row.key),
								),
								byScoreDescending,
							),
						),
						{ onNone: () => own, onSome: ({ row }) => row.key },
					)
		return [HashSet.add(taken, key), { key, step }] as const
	})
	// Two steps can land on one key (a reviewer step repeating a diff step's subject); keep the first.
	const unique = Arr.dedupeWith(keyed, (a, b) => a.key === b.key)
	const upserts = Arr.map(unique, ({ key, step }) => {
		const { done: _done, doneBy: _doneBy, key: _key, ...base } = step
		const row = byKey.get(key)
		return {
			key,
			step: new PrReviewMergeStep({
				...base,
				key,
				...(row?.status === "done"
					? { done: true, ...(row.doneBy === null ? undefined : { doneBy: row.doneBy }) }
					: undefined),
			}),
		}
	})
	return {
		steps: Arr.map(upserts, ({ step }) => step),
		upserts,
		obsolete: Arr.map(
			Arr.filter(stored, (row) => row.status === "open" && !HashSet.has(claimed, row.key)),
			(row) => row.key,
		),
	}
}
