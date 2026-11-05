// Reading view of the OTel GenAI (`gen_ai.*`) span attributes.
//
// A span's `gen_ai.*` keys are lifted out of the raw attribute map into
// labelled, grouped fields, so `gen_ai.usage.cache_read.input_tokens = 0` reads
// as "Cache read 0" under "Token usage". Nothing is filtered and nothing is
// guessed: a key this table has never heard of still renders, in the group its
// path names, under a label derived from that path, with its value verbatim.
//
// The key list mirrors the field catalog in `@maple/domain` (`AI_GENAI_FIELDS`)
// plus the legacy aliases real spans still emit. The labels live here because a
// label is a UI decision the convention does not make.

import { Option, Schema, Array as Arr, Record as Rec, String as Str } from "effect"

import { formatDuration } from "./format"

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

const GEN_AI_PREFIX = "gen_ai."

/**
 * The group vocabulary, declared once: the keys are the ids and the reading
 * order, the values are the headers.
 */
const GROUP_LABELS = {
	operation: "Operation",
	request: "Request",
	response: "Response",
	usage: "Token usage",
	conversation: "Conversation",
	agent: "Agent",
	tool: "Tool",
	content: "Messages",
	retrieval: "Retrieval",
	memory: "Memory",
	embeddings: "Embeddings",
	evaluation: "Evaluation",
	prompt: "Prompt",
	workflow: "Workflow",
	other: "Other",
} as const satisfies Record<string, string>

type GenAiGroupId = keyof typeof GROUP_LABELS

/** Path segments that name a group other than themselves. */
const GROUP_ALIASES: Record<string, string> = {
	provider: "operation",
	system: "operation",
	input: "content",
	system_instructions: "content",
	output: "response",
	data_source: "retrieval",
} satisfies Record<string, GenAiGroupId>

/** The three keys whose own path names a group they don't belong in. */
const GROUP_OVERRIDES: Record<string, string> = {
	"gen_ai.output.messages": "content",
	"gen_ai.prompt": "content",
	"gen_ai.completion": "content",
} satisfies Record<string, GenAiGroupId>

/**
 * Key → label. Declaration order is the order the fields read inside their
 * group, so a group runs the way someone reasons about it (what was asked,
 * what came back, what it cost) rather than alphabetically. Exported so the
 * test can assert that no two fields in a group answer to the same label.
 */
export const GEN_AI_LABELS: Record<string, string> = {
	// operation
	"gen_ai.operation.name": "Operation",
	"gen_ai.provider.name": "Provider",
	// The name the convention used before `gen_ai.provider.name`, and still the
	// only one some instrumentations send.
	"gen_ai.system": "Provider (legacy key)",

	// request
	"gen_ai.request.model": "Requested model",
	"gen_ai.request.max_tokens": "Max tokens",
	"gen_ai.request.temperature": "Temperature",
	"gen_ai.request.top_p": "Top P",
	"gen_ai.request.top_k": "Top K",
	"gen_ai.request.frequency_penalty": "Frequency penalty",
	"gen_ai.request.presence_penalty": "Presence penalty",
	"gen_ai.request.stop_sequences": "Stop sequences",
	"gen_ai.request.choice.count": "Choices requested",
	"gen_ai.request.seed": "Seed",
	"gen_ai.request.stream": "Streaming",
	"gen_ai.request.reasoning.level": "Reasoning level",
	"gen_ai.request.encoding_formats": "Encoding formats",
	"gen_ai.request.previous_response.id": "Previous response ID",
	"gen_ai.request.stream_cursor": "Stream cursor",

	// response
	"gen_ai.response.model": "Response model",
	"gen_ai.response.finish_reasons": "Finish reason",
	"gen_ai.response.finish_reason": "Finish reason (legacy key)",
	"gen_ai.response.status": "Response status",
	"gen_ai.response.time_to_first_chunk": "Time to first token",
	"gen_ai.output.type": "Output type",
	"gen_ai.response.id": "Response ID",

	// usage — the vendor's own cost, in whatever currency it priced in.
	"gen_ai.usage.input_tokens": "Input",
	"gen_ai.usage.output_tokens": "Output",
	"gen_ai.usage.cache_read.input_tokens": "Cache read",
	// Two spellings of the same quantity: `cache_creation` is the Anthropic-SDK
	// dialect (and the read side's primary), `cache_write` the registry spelling
	// Maple's own agents emit. An emitter uses one or the other, never both — but
	// the suffix keeps the table honest if one ever sends both.
	"gen_ai.usage.cache_creation.input_tokens": "Cache write",
	"gen_ai.usage.cache_write.input_tokens": "Cache write (registry key)",
	"gen_ai.usage.reasoning.output_tokens": "Reasoning",
	"gen_ai.usage.cost": "Cost",
	// Legacy spellings, all still in the wild. The suffix is what keeps two rows
	// for the same quantity apart in a group.
	"gen_ai.usage.prompt_tokens": "Input (legacy key)",
	"gen_ai.usage.completion_tokens": "Output (legacy key)",
	"gen_ai.usage.input_tokens.cached": "Cache read (legacy key)",
	"gen_ai.usage.output_tokens.reasoning": "Reasoning (legacy key)",

	// conversation
	"gen_ai.conversation.id": "Conversation ID",
	"gen_ai.conversation.compacted": "History compacted",

	// agent
	"gen_ai.agent.name": "Name",
	"gen_ai.agent.id": "ID",
	"gen_ai.agent.description": "Description",
	"gen_ai.agent.version": "Version",

	// tool
	"gen_ai.tool.name": "Name",
	"gen_ai.tool.type": "Type",
	"gen_ai.tool.description": "Description",
	"gen_ai.tool.call.id": "Call ID",
	"gen_ai.tool.call.arguments": "Arguments",
	"gen_ai.tool.call.result": "Result",
	"gen_ai.tool.definitions": "Definitions",

	// content
	"gen_ai.system_instructions": "System instructions",
	"gen_ai.input.messages": "Input messages",
	"gen_ai.output.messages": "Output messages",
	"gen_ai.prompt": "Prompt (legacy key)",
	"gen_ai.completion": "Completion (legacy key)",

	// retrieval
	"gen_ai.data_source.id": "Data source ID",
	"gen_ai.retrieval.query.text": "Query",
	"gen_ai.retrieval.top_k": "Top K",
	"gen_ai.retrieval.documents": "Documents",

	// memory
	"gen_ai.memory.store.id": "Store ID",
	"gen_ai.memory.record.id": "Record ID",
	"gen_ai.memory.record.count": "Record count",
	"gen_ai.memory.query.text": "Query",
	"gen_ai.memory.records": "Records",

	// embeddings
	"gen_ai.embeddings.dimension.count": "Dimensions",

	// evaluation
	"gen_ai.evaluation.name": "Name",
	"gen_ai.evaluation.score.value": "Score",
	"gen_ai.evaluation.score.label": "Score label",
	"gen_ai.evaluation.explanation": "Explanation",

	// prompt
	"gen_ai.prompt.name": "Name",
	"gen_ai.prompt.version": "Version",

	// workflow
	"gen_ai.workflow.name": "Name",
} satisfies Record<string, string>

/** Field order within a group, precomputed from the label table. */
const FIELD_ORDER: ReadonlyMap<string, number> = new Map(
	Arr.map(Rec.keys(GEN_AI_LABELS), (key, index) => [key, index]),
)

/**
 * `gen_ai.prompt.variable.<name>` puts the variable name IN the key, so it can
 * never appear in a fixed table — it is matched by prefix instead.
 */
const PROMPT_VARIABLE_PREFIX = "gen_ai.prompt.variable."

/**
 * Token counts, the one quantity here big enough to need thousands separators.
 * Every other number prints as sent, so `0` never becomes `0.0`, `1e-7` never
 * becomes `0`, and an id-shaped value is never re-spelled as a quantity.
 */
const TOKEN_COUNT_KEYS: ReadonlySet<string> = new Set([
	"gen_ai.request.max_tokens",
	"gen_ai.usage.input_tokens",
	"gen_ai.usage.output_tokens",
	"gen_ai.usage.cache_read.input_tokens",
	"gen_ai.usage.cache_creation.input_tokens",
	"gen_ai.usage.cache_write.input_tokens",
	"gen_ai.usage.reasoning.output_tokens",
	"gen_ai.usage.prompt_tokens",
	"gen_ai.usage.completion_tokens",
	"gen_ai.usage.input_tokens.cached",
	"gen_ai.usage.output_tokens.reasoning",
])

/** Seconds by convention, unlike every other duration in the product. */
const TIME_TO_FIRST_TOKEN_KEY = "gen_ai.response.time_to_first_chunk"

/** Array-valued keys: `["stop"]` is one finish reason, and the brackets are noise. */
const LIST_KEYS: ReadonlySet<string> = new Set([
	"gen_ai.response.finish_reasons",
	"gen_ai.request.stop_sequences",
	"gen_ai.request.encoding_formats",
])

export interface GenAiField {
	/** Full attribute key — what a copy yields, and the React key. */
	readonly key: string
	readonly label: string
	/** Reading text. Equal to `rawValue` unless the key has a formatter. */
	readonly value: string
	readonly rawValue: string
}

export interface GenAiGroup {
	readonly id: string
	readonly label: string
	readonly fields: ReadonlyArray<GenAiField>
}

/**
 * Splits `gen_ai.*` out of an attribute map into labelled groups. Everything
 * else stays in `rest` for the raw table — including a blank `gen_ai.*` value,
 * which is not worth a labelled row but is still a key the span carried.
 */
export function splitGenAiAttributes(attributes: Record<string, string>): {
	groups: ReadonlyArray<GenAiGroup>
	rest: Record<string, string>
} {
	const rest: Record<string, string> = {}
	const byGroup = new Map<string, GenAiField[]>()

	for (const [key, rawValue] of Rec.toEntries(attributes)) {
		if (!Str.startsWith(GEN_AI_PREFIX)(key) || Str.trim(rawValue) === "") {
			rest[key] = rawValue
			continue
		}
		const group = groupOf(key)
		const fields = byGroup.get(group) ?? []
		fields.push({ key, label: labelOf(key, group), value: formatValue(key, rawValue), rawValue })
		byGroup.set(group, fields)
	}

	const groups: GenAiGroup[] = []
	for (const [id, label] of Rec.toEntries(GROUP_LABELS)) {
		const fields = byGroup.get(id)
		if (fields === undefined) continue
		fields.sort(compareFields)
		groups.push({ id, label, fields })
	}

	return { groups, rest }
}

/** The group the key belongs to: its own path segment unless it names another. */
function groupOf(key: string): string {
	const override = Rec.get(GROUP_OVERRIDES, key)
	if (Option.isSome(override)) return override.value
	const namespace = namespaceOf(key)
	if (Arr.some(Rec.keys(GROUP_LABELS), (id) => id === namespace)) return namespace
	const alias = Rec.get(GROUP_ALIASES, namespace)
	if (Option.isSome(alias)) return alias.value
	return "other"
}

/** Table label, else one read off the key's own path. */
function labelOf(key: string, group: string): string {
	const known = Rec.get(GEN_AI_LABELS, key)
	if (Option.isSome(known)) return known.value
	if (Str.startsWith(PROMPT_VARIABLE_PREFIX)(key)) return Str.slice(PROMPT_VARIABLE_PREFIX.length)(key)

	const path = Str.slice(GEN_AI_PREFIX.length)(key)
	// Inside a named group the header already says the namespace, so the leaf
	// alone is the label — `gen_ai.usage.reasoning_tokens` reads as "Reasoning
	// Tokens" under "Token usage", beside the counts it belongs with.
	const namespace = namespaceOf(key)
	const remainder = group === "other" ? path : Str.slice(namespace.length + 1)(path)
	return humanizeKeyPath(remainder === "" ? path : remainder)
}

function namespaceOf(key: string): string {
	return Str.split(".")(Str.slice(GEN_AI_PREFIX.length)(key))[0] ?? ""
}

/** `reasoning_tokens` → `Reasoning Tokens`; `call.id` → `Call ID`. */
function humanizeKeyPath(path: string): string {
	const words = Arr.map(
		Arr.filter(Str.split(/[._]/)(path), (part) => part !== ""),
		(word) => (word === "id" ? "ID" : Str.toUpperCase(Str.slice(0, 1)(word)) + Str.slice(1)(word)),
	)
	return words.length === 0 ? path : Arr.join(words, " ")
}

/** Table order first; unlisted keys after it, alphabetically. */
function compareFields(a: GenAiField, b: GenAiField): number {
	const orderA = FIELD_ORDER.get(a.key) ?? Number.MAX_SAFE_INTEGER
	const orderB = FIELD_ORDER.get(b.key) ?? Number.MAX_SAFE_INTEGER
	if (orderA !== orderB) return orderA - orderB
	return Str.localeCompare(b.key)(a.key)
}

/** Reading text for a raw attribute string — the key decides, never the value. */
function formatValue(key: string, rawValue: string): string {
	if (TOKEN_COUNT_KEYS.has(key)) {
		const parsed = Number(rawValue)
		return Number.isFinite(parsed) ? parsed.toLocaleString() : rawValue
	}
	if (key === TIME_TO_FIRST_TOKEN_KEY) {
		const parsed = Number(rawValue)
		return Number.isFinite(parsed) ? formatDuration(parsed * 1000) : rawValue
	}
	if (LIST_KEYS.has(key)) {
		const flat = parseFlatArray(rawValue)
		// An empty array keeps its raw "[]" — a blank value cell reads as missing.
		return flat === null || flat.length === 0 ? rawValue : Arr.join(flat, ", ")
	}
	return rawValue
}

/** An array of primitives, else null — an array of objects stays JSON. */
function parseFlatArray(rawValue: string): string[] | null {
	if (Str.trimStart(rawValue)[0] !== "[") return null
	const parsed = Option.getOrNull(decodeJson(rawValue))
	if (!Arr.isArray(parsed)) return null
	if (!Arr.every(parsed, (item) => item === null || typeof item !== "object")) return null
	return Arr.map(parsed, (item) => String(item))
}
