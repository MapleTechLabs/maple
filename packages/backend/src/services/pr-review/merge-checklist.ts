/**
 * The "before merge" checklist read off a pull request's diff: secrets and environment variables
 * the change starts reading, migrations it adds, warehouse schema and deployment config it edits.
 * Pure over the changed files; the service confirms each name is new before it is listed.
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

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1)

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
					title: `New migration \`${path}\`: check it runs against production data and the code still deployed`,
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
					title: `Warehouse schema changed in \`${basename(path)}\`: deploy it before the code that reads it`,
					path,
					source: "diff",
				}),
			)
		} else if (INFRA.test(path)) {
			steps.push(
				new PrReviewMergeStep({
					kind: "infra",
					title: `Deployment config changed in \`${basename(path)}\`: check every environment has what it now expects`,
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

/** The step for a name the base does not read yet. */
export const nameStep = (candidate: MergeStepName): PrReviewMergeStep => {
	const name = `\`${candidate.name}\``
	const title = candidate.ci
		? candidate.kind === "secret"
			? `Add the ${name} secret to the repository's CI secrets`
			: `Add the ${name} variable to the repository's CI variables`
		: candidate.kind === "secret"
			? `Add the secret ${name} to every environment this deploys to`
			: `Set ${name} in every environment this deploys to, or confirm its default is right`
	return new PrReviewMergeStep({
		kind: candidate.kind,
		title,
		path: candidate.path,
		line: candidate.line,
		source: "diff",
	})
}

/** The steps for one pull request, most likely to be forgotten first. */
const KIND_ORDER = { secret: 0, env: 1, migration: 2, warehouse: 3, infra: 4, manual: 5 } as const
const MAX_STEPS = 15

/**
 * The diff's steps and the reviewer's, as one list. A reviewer step that names a diff step's
 * secret or file replaces it: the reviewer read the repository's conventions and says where.
 */
export const mergeChecklist = (
	diff: ReadonlyArray<PrReviewMergeStep>,
	reviewer: ReadonlyArray<PrReviewMergeStep>,
): ReadonlyArray<PrReviewMergeStep> => {
	const subjectOf = (step: PrReviewMergeStep) => /`([^`]+)`/.exec(step.title)?.[1] ?? step.path
	const covered = (step: PrReviewMergeStep) => {
		const subject = subjectOf(step)
		return (
			subject !== undefined &&
			reviewer.some((other) => other.title.includes(subject) || other.title.includes(basename(subject)))
		)
	}
	return [...diff.filter((step) => !covered(step)), ...reviewer]
		.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
		.slice(0, MAX_STEPS)
}
