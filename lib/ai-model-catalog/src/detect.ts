import { OPENROUTER_MODELS, OPENROUTER_VENDORS } from "./generated/openrouter-catalog"
import { BEDROCK_VENDORS, FAMILY_RULES, VENDOR_NAME_OVERRIDES, VENDOR_PREFIX_RULES } from "./vendors"

/** What a model string resolved to. Every field but `model` and `slug` is a best effort. */
export interface DetectedAiModel {
	/** The input, trimmed. */
	readonly model: string
	/** The model segment as given, lowercased, variant kept: `glm-5.3-flash:nitro`. */
	readonly slug: string
	/**
	 * The slug with its variant and provider decoration removed, spelled the
	 * way OpenRouter spells it when the model is listed there:
	 * `claude-sonnet-4-5-20250929` → `claude-sonnet-4.5`. A dated id OpenRouter
	 * lists as its own snapshot (`gpt-4o-2024-08-06`) keeps its date.
	 */
	readonly normalizedSlug: string
	/** `vendorSlug/normalizedSlug` when OpenRouter lists the model, else `null`. */
	readonly openRouterId: string | null
	/** `GLM 5.3 Flash` — OpenRouter's name, or one derived from the slug. */
	readonly displayName: string
	/** `z-ai` — OpenRouter's author segment, the key an icon lookup uses. */
	readonly vendorSlug: string | null
	/** `Z.ai` */
	readonly vendorName: string | null
	/** A product family with a mark of its own (`claude`, `gemini`), else `null`. */
	readonly family: string | null
	/** How the vendor was found. `unknown` means only `slug` and `displayName` are meaningful. */
	readonly source: "openrouter" | "heuristic" | "unknown"
}

interface CatalogEntry {
	readonly vendorSlug: string
	readonly modelSlug: string
	readonly name: string
}

const splitId = (id: string): readonly [vendor: string, model: string] => {
	const slash = id.indexOf("/")
	return slash === -1 ? ["", id] : [id.slice(0, slash), id.slice(slash + 1)]
}

const stripVariant = (slug: string): string => {
	const colon = slug.indexOf(":")
	return colon === -1 ? slug : slug.slice(0, colon)
}

/** Trailing date stamps and release numbers: `-20250929`, `-2025-08-07`, `-0125`, `-002`, `-05-06`. */
const DATE_SUFFIX = /-(\d{8}|\d{4}-\d{2}-\d{2}|\d{2}-\d{2}|\d{3,4})$/
const CHANNEL_SUFFIX = /-(latest|preview|exp)$/
const BEDROCK_ID = /^(?:(?:us|eu|apac|global|jp|au|ca|us-gov)\.)?([a-z0-9]+)\.(.+?)(?:-v\d+)?(?::\d+)?$/

/**
 * The catalog, indexed by the model segment alone. Keys are added in
 * confidence order and never overwritten: a listed id's own segment first,
 * then the dated canonical slug and its undated form, so a raw provider id
 * that carries a date (`gpt-5-2025-08-07`) still lands on its entry.
 */
const byModelSlug = new Map<string, CatalogEntry>()
const byName = new Map<string, string>()

/** `Z.ai: GLM 5.3 Flash (batch)` → `GLM 5.3 Flash`. */
const displayNameOf = (name: string): string => {
	const separator = name.indexOf(": ")
	const display = separator === -1 ? name : name.slice(separator + 2)
	// `:batch` and `:free` variants carry their variant in the name.
	return display.replace(/\s*\((batch|free|beta)\)$/i, "")
}

const add = (key: string, entry: CatalogEntry) => {
	if (!byModelSlug.has(key)) byModelSlug.set(key, entry)
}

// Rolling aliases (`~anthropic/claude-sonnet-latest`) and variants are listed
// after the plain ids so a plain id always owns its own key.
const ordered = [...OPENROUTER_MODELS].sort(([a], [b]) => {
	const rank = (id: string) => (id.startsWith("~") ? 2 : id.includes(":") ? 1 : 0)
	return rank(a) - rank(b)
})
for (const [id, canonicalSlug, name] of ordered) {
	const [author, model] = splitId(id)
	const vendorSlug = author.replace(/^~/, "")
	const modelSlug = stripVariant(model)
	const entry: CatalogEntry = { vendorSlug, modelSlug, name }
	byName.set(`${vendorSlug}/${modelSlug}`, name)
	add(modelSlug, entry)
	add(`${vendorSlug}/${modelSlug}`, entry)
	const [, canonicalModel] = splitId(canonicalSlug)
	add(canonicalModel, entry)
	add(canonicalModel.replace(DATE_SUFFIX, ""), entry)
}

const vendorNameOf = (vendorSlug: string): string =>
	VENDOR_NAME_OVERRIDES[vendorSlug] ?? OPENROUTER_VENDORS[vendorSlug] ?? titleCase(vendorSlug)

const familyOf = (normalizedSlug: string): string | null =>
	FAMILY_RULES.find(([pattern]) => pattern.test(normalizedSlug))?.[1] ?? null

/** Short tokens that are initialisms rather than words. */
const ACRONYMS = new Set(["gpt", "glm", "lfm", "ai", "mpt", "dbrx", "qwq", "qvq", "tts", "hy"])

/** `gpt-4o-mini` → `GPT 4o Mini`, `deepseek-r1-70b` → `Deepseek R1 70B`, `my-deployment` → `My Deployment`. */
const titleCase = (slug: string): string =>
	slug
		.split(/[-_ ]+/)
		.filter(Boolean)
		.map((word) => {
			if (ACRONYMS.has(word)) return word.toUpperCase()
			// `r1`, `v3`, `k2` — but not OpenAI's `o3`.
			if (/^[a-np-z]\d+$/.test(word)) return word.toUpperCase()
			// Parameter counts: `70b`, `8b`, `1.5b`.
			if (/^\d+(\.\d+)?[bkm]$/.test(word)) return word.toUpperCase()
			return word.charAt(0).toUpperCase() + word.slice(1)
		})
		.join(" ")

/**
 * Progressively less specific spellings of a model segment, most specific
 * first. The catalog lookup takes the first one that hits.
 */
const candidates = (modelSlug: string): ReadonlyArray<string> => {
	const seen = new Set<string>()
	const out: string[] = []
	const push = (value: string) => {
		if (value && !seen.has(value)) {
			seen.add(value)
			out.push(value)
		}
	}
	let current = modelSlug
	push(current)
	for (let round = 0; round < 4; round++) {
		const undated = current.replace(DATE_SUFFIX, "")
		// `claude-3-5-sonnet` → `claude-3.5-sonnet`, leaving `llama3-1-70b`'s `1-70b` alone.
		const dotted = undated.replace(/(\d)-(\d)(?=[-.]|$)/g, "$1.$2")
		const unchanneled = dotted.replace(CHANNEL_SUFFIX, "")
		// `llama3.1` (Ollama, Bedrock) → `llama-3.1`, the spelling OpenRouter uses.
		const hyphenated = unchanneled.replace(/^([a-z]+)(\d)/, "$1-$2")
		push(undated)
		push(dotted)
		push(unchanneled)
		push(hyphenated)
		if (hyphenated === current) break
		current = hyphenated
	}
	return out
}

/**
 * Resolve a model string — an OpenRouter id, a provider's raw model id, a
 * LiteLLM/Bedrock/Vertex-decorated one — to its vendor and display name.
 * Never fails: an unrecognised string comes back with `source: "unknown"`
 * and a display name derived from the string itself.
 */
export const detectAiModel = (input: string): DetectedAiModel => {
	const model = input.trim()
	const lower = model.toLowerCase()

	// Path-shaped ids: `openrouter/anthropic/claude-3.5-sonnet`,
	// `publishers/google/models/gemini-2.5-pro`. The model is the last segment;
	// the segment before it names the vendor only when it is one we know.
	const segments = lower.split("/").filter(Boolean)
	let slug = segments.at(-1) ?? lower
	let pathVendor = segments.length > 1 ? (segments[segments.length - 2] ?? "").replace(/^~/, "") : null
	if (
		pathVendor !== null &&
		!(pathVendor in OPENROUTER_VENDORS) &&
		!(pathVendor in VENDOR_NAME_OVERRIDES)
	) {
		pathVendor = null
	}

	// Bedrock: `us.anthropic.claude-3-5-sonnet-20241022-v2:0`.
	const [, bedrockVendor = "", bedrockModel = ""] =
		(pathVendor === null ? BEDROCK_ID.exec(slug) : null) ?? []
	const bedrockSlug = BEDROCK_VENDORS[bedrockVendor]
	if (bedrockSlug !== undefined) {
		pathVendor = bedrockSlug
		slug = bedrockModel
	}

	const base = stripVariant(slug)
	const lookup = (key: string) => byModelSlug.get(pathVendor ? `${pathVendor}/${key}` : key)
	let entry: CatalogEntry | undefined
	let matched = base
	for (const candidate of candidates(base)) {
		entry = lookup(candidate) ?? (pathVendor ? byModelSlug.get(candidate) : undefined)
		if (entry) {
			matched = candidate
			break
		}
	}

	if (entry) {
		const vendorName = vendorNameOf(entry.vendorSlug)
		const name = byName.get(`${entry.vendorSlug}/${entry.modelSlug}`) ?? entry.name
		return {
			model,
			slug,
			normalizedSlug: entry.modelSlug,
			openRouterId: `${entry.vendorSlug}/${entry.modelSlug}`,
			displayName: displayNameOf(name),
			vendorSlug: entry.vendorSlug,
			vendorName,
			family: familyOf(entry.modelSlug),
			source: "openrouter",
		}
	}

	const normalizedSlug = candidates(base).at(-1) ?? matched
	const vendorSlug =
		pathVendor ?? VENDOR_PREFIX_RULES.find(([pattern]) => pattern.test(normalizedSlug))?.[1] ?? null
	return {
		model,
		slug,
		normalizedSlug,
		openRouterId: null,
		displayName: titleCase(normalizedSlug),
		vendorSlug,
		vendorName: vendorSlug === null ? null : vendorNameOf(vendorSlug),
		family: familyOf(normalizedSlug),
		source: vendorSlug === null ? "unknown" : "heuristic",
	}
}
