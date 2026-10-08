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
import { PrReviewMergeStep, type PullRequestFile } from "@maple/domain/http"

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

interface PatchLine {
	readonly text: string
	/** The line in the new file; the line it sat before for a removed one. */
	readonly line: number
}

/** A unified diff split into the lines it adds, with their head line numbers, and the lines it removes. */
const splitPatch = (patch: string): { added: Array<PatchLine>; removed: Array<string> } => {
	const added: Array<PatchLine> = []
	const removed: Array<string> = []
	let line = 0
	for (const raw of patch.split("\n")) {
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw)
		if (hunk !== null) {
			line = Number(hunk[1])
			continue
		}
		if (raw.startsWith("+")) {
			added.push({ text: raw.slice(1), line })
			line++
		} else if (raw.startsWith("-")) {
			removed.push(raw.slice(1))
		} else if (!raw.startsWith("\\")) {
			line++
		}
	}
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
		const { added, removed } = file.patch === null ? { added: [], removed: [] } : splitPatch(file.patch)
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

		if (TEST_PATH.test(path) || DOC_PATH.test(path) || LOCAL_PATH.test(path)) continue
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
export type NameVerdict = "new" | "exists" | "unverified"

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
	const all = [...kept, ...input.reviewer].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
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
