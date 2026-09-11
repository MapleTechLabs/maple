import { OPENROUTER_MODELS, OPENROUTER_VENDORS } from "./generated/openrouter-catalog"
import {
	BEDROCK_VENDORS,
	type BrandColor,
	FAMILY_RULES,
	VENDOR_BRAND_COLORS,
	VENDOR_NAME_OVERRIDES,
	VENDOR_PREFIX_RULES,
} from "./vendors"

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
	/**
	 * The id OpenRouter serves when it lists the model, else `null`. A rolling
	 * alias keeps its `~` (`~anthropic/claude-sonnet-latest`), so the id is
	 * always one OpenRouter answers to; `vendorSlug` never carries it.
	 */
	readonly openRouterId: string | null
	/**
	 * `GLM 5.3 Flash` — OpenRouter's name, or one derived from the slug, with
	 * any routing variant kept: `GLM 5.3 Flash (nitro)`.
	 */
	readonly displayName: string
	/** `z-ai` — OpenRouter's author segment, the key an icon lookup uses. */
	readonly vendorSlug: string | null
	/** `Z.ai` */
	readonly vendorName: string | null
	/** The vendor's brand color on each canvas, when the catalog lists one. */
	readonly brandColor: BrandColor | null
	/** A product family with a mark of its own (`claude`, `gemini`, `grok`, `kimi`), else `null`. */
	readonly family: string | null
	/** How the vendor was found. `unknown` means only `slug` and `displayName` are meaningful. */
	readonly source: "openrouter" | "heuristic" | "unknown"
}

interface CatalogEntry {
	/** The id OpenRouter serves, author segment verbatim — `~` aliases keep their `~`. */
	readonly openRouterId: string
	readonly vendorSlug: string
	readonly modelSlug: string
	readonly name: string
}

/** A record read that ignores the prototype: `constructor` is not a vendor. */
const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
	Object.hasOwn(record, key) ? record[key] : undefined

const splitId = (id: string): readonly [vendor: string, model: string] => {
	const slash = id.indexOf("/")
	return slash === -1 ? ["", id] : [id.slice(0, slash), id.slice(slash + 1)]
}

const stripVariant = (slug: string): string => {
	const colon = slug.indexOf(":")
	return colon === -1 ? slug : slug.slice(0, colon)
}

/**
 * What follows a `:` — OpenRouter's routing variants (`:nitro`, `:free`) and
 * Ollama's tags (`:8b`, `:instruct`) alike. A digits-only suffix is a Bedrock
 * version (`…-v1:0`) and names nothing.
 */
const VARIANT = /^(?!\d+$)[a-z0-9][a-z0-9._-]*$/

const variantOf = (slug: string): string | null => {
	const colon = slug.indexOf(":")
	if (colon === -1) return null
	const variant = slug.slice(colon + 1)
	return VARIANT.test(variant) ? variant : null
}

/**
 * `GLM 5.3 Flash` + `nitro` → `GLM 5.3 Flash (nitro)`. The variant is part of
 * the name because it is part of the identity: `glm-5.3-flash` and
 * `glm-5.3-flash:nitro` differ in price and availability, and two rows sharing
 * one name read as one model that was double-counted.
 */
const withVariant = (displayName: string, variant: string | null): string =>
	variant === null ? displayName : `${displayName} (${variant})`

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

/**
 * `Z.ai: GLM 5.3 Flash (batch)` → `GLM 5.3 Flash`. The parenthetical only
 * reaches here for a model OpenRouter lists solely as a variant; a plain id
 * owns its entry (see the ordering below), variant names never replace it.
 */
const displayNameOf = (name: string): string => {
	const separator = name.indexOf(": ")
	const display = separator === -1 ? name : name.slice(separator + 2)
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
	const entry: CatalogEntry = { openRouterId: `${author}/${modelSlug}`, vendorSlug, modelSlug, name }
	const [, canonicalModel] = splitId(canonicalSlug)
	for (const key of [modelSlug, canonicalModel, canonicalModel.replace(DATE_SUFFIX, "")]) {
		add(key, entry)
		add(`${vendorSlug}/${key}`, entry)
	}
}

/** Short tokens that are initialisms rather than words. */
const ACRONYMS = new Set(["gpt", "glm", "lfm", "ai", "mpt", "dbrx", "qwq", "qvq", "tts", "hy"])

/** `gpt-4o-mini` → `GPT 4o Mini`, `deepseek-r1-70b` → `Deepseek R1 70B`, `my-deployment` → `My Deployment`. */
const titleCase = (slug: string): string =>
	slug
		.split(/[-_ ]+/)
		.filter(Boolean)
		.map((word) => {
			if (ACRONYMS.has(word)) return word.toUpperCase()
			// `r1`, `v3`, `k2` — but OpenAI's `o3` stays lowercase.
			if (/^o\d+$/.test(word)) return word
			if (/^[a-z]\d+$/.test(word)) return word.toUpperCase()
			// Parameter counts: `70b`, `8b`, `1.5b`.
			if (/^\d+(\.\d+)?[bkm]$/.test(word)) return word.toUpperCase()
			return word.charAt(0).toUpperCase() + word.slice(1)
		})
		.join(" ")

const vendorNameOf = (vendorSlug: string): string =>
	own(VENDOR_NAME_OVERRIDES, vendorSlug) ?? own(OPENROUTER_VENDORS, vendorSlug) ?? titleCase(vendorSlug)

const brandColorOf = (vendorSlug: string): BrandColor | null => own(VENDOR_BRAND_COLORS, vendorSlug) ?? null

const isKnownVendor = (slug: string): boolean =>
	Object.hasOwn(OPENROUTER_VENDORS, slug) || Object.hasOwn(VENDOR_NAME_OVERRIDES, slug)

const familyOf = (normalizedSlug: string): string | null =>
	FAMILY_RULES.find(([pattern]) => pattern.test(normalizedSlug))?.[1] ?? null

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
		// `llama3.1` (Ollama, Bedrock) → `llama-3.1`, the spelling OpenRouter uses;
		// a single letter stays put, OpenAI's `o3` is not `o-3`.
		const hyphenated = unchanneled.replace(/^([a-z]{2,})(\d)/, "$1-$2")
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
	// the nearest earlier segment that names a vendor we know is the vendor.
	const segments = lower.split("/").filter(Boolean)
	let slug = segments.at(-1) ?? lower
	let pathVendor: string | null = null
	for (let index = segments.length - 2; index >= 0; index--) {
		const segment = (segments[index] ?? "").replace(/^~/, "")
		if (isKnownVendor(segment)) {
			pathVendor = segment
			break
		}
	}

	// Bedrock: `us.anthropic.claude-3-5-sonnet-20241022-v2:0`.
	const [, bedrockVendor = "", bedrockModel = ""] =
		(pathVendor === null ? BEDROCK_ID.exec(slug) : null) ?? []
	const bedrockSlug = own(BEDROCK_VENDORS, bedrockVendor)
	if (bedrockSlug !== undefined) {
		pathVendor = bedrockSlug
		slug = bedrockModel
	}

	// An explicit vendor is binding: `anthropic/gpt-4o` is not OpenAI's model
	// however the segment reads, so the lookup is vendor-qualified and an
	// unlisted pairing falls through to the heuristic path with that vendor.
	const base = stripVariant(slug)
	const variant = variantOf(slug)
	const spellings = candidates(base)
	let entry: CatalogEntry | undefined
	for (const candidate of spellings) {
		entry = byModelSlug.get(pathVendor === null ? candidate : `${pathVendor}/${candidate}`)
		if (entry) break
	}

	if (entry) {
		return {
			model,
			slug,
			normalizedSlug: entry.modelSlug,
			openRouterId: entry.openRouterId,
			displayName: withVariant(displayNameOf(entry.name), variant),
			vendorSlug: entry.vendorSlug,
			vendorName: vendorNameOf(entry.vendorSlug),
			brandColor: brandColorOf(entry.vendorSlug),
			family: familyOf(entry.modelSlug),
			source: "openrouter",
		}
	}

	const normalizedSlug = spellings.at(-1) ?? base
	const vendorSlug =
		pathVendor ?? VENDOR_PREFIX_RULES.find(([pattern]) => pattern.test(normalizedSlug))?.[1] ?? null
	// `titleCase` has nothing to say about a punctuation-only string; the raw
	// input it falls back to already carries its variant.
	const titled = titleCase(normalizedSlug)
	return {
		model,
		slug,
		normalizedSlug,
		openRouterId: null,
		displayName: titled === "" ? model : withVariant(titled, variant),
		vendorSlug,
		vendorName: vendorSlug === null ? null : vendorNameOf(vendorSlug),
		brandColor: vendorSlug === null ? null : brandColorOf(vendorSlug),
		family: familyOf(normalizedSlug),
		source: vendorSlug === null ? "unknown" : "heuristic",
	}
}
