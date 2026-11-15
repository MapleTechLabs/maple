// BOUNDARY-FILE: This module intentionally carries opaque values; callers decode them before domain use.
// OTLP profiles (the pprof-shaped `v1development` payload) flattened to `profiles` rows: one row
// per stack, span link and attribute set per profile, the producer's samples of it summed. The
// dictionary is resolved here and never stored.
import { Array as Arr, Option, Result, Schema, String as Str } from "effect"
import { encodeJson } from "../json"
import {
	type AnyValue,
	anyValueString,
	type EncodedBatch,
	formatTimestampNano,
	spanIdHex,
	traceIdHex,
} from "./encode"

type Int64 = string | number

interface ProfileAnyValue extends AnyValue {
	stringValueStrindex?: number
}
interface ProfileKeyValue {
	key?: string | null
	keyStrindex?: number
	value?: ProfileAnyValue | null
}
interface ValueType {
	typeStrindex?: number
	unitStrindex?: number
}
interface Sample {
	stackIndex?: number
	attributeIndices?: number[]
	linkIndex?: number
	values?: Int64[]
	timestampsUnixNano?: Int64[]
}
interface Profile {
	sampleType?: ValueType
	samples?: Sample[]
	timeUnixNano?: Int64
	durationNano?: Int64
	periodType?: ValueType
	period?: Int64
	profileId?: string
	attributeIndices?: number[]
}
interface Dictionary {
	mappingTable?: { filenameStrindex?: number }[]
	locationTable?: {
		mappingIndex?: number
		address?: Int64
		lines?: { functionIndex?: number; line?: Int64 }[]
	}[]
	functionTable?: {
		nameStrindex?: number
		systemNameStrindex?: number
		filenameStrindex?: number
		startLine?: Int64
	}[]
	linkTable?: { traceId?: string; spanId?: string }[]
	stringTable?: string[]
	attributeTable?: { keyStrindex?: number; value?: ProfileAnyValue | null }[]
	stackTable?: { locationIndices?: number[] }[]
}
export interface ProfilesRequest {
	resourceProfiles?: {
		resource?: { attributes?: ProfileKeyValue[] }
		scopeProfiles?: { profiles?: Profile[] }[]
	}[]
	dictionary?: Dictionary
}

const opt = <S extends Schema.Top>(schema: S) => Schema.optionalKey(Schema.NullOr(schema))
const list = <S extends Schema.Top>(schema: S) => opt(Schema.Array(schema))
const Int64Json = Schema.Union([Schema.Int, Schema.String.check(Schema.isPattern(/^-?\d+$/))])
const Index = opt(Schema.Int)
const ValueTypeJson = opt(Schema.Struct({ typeStrindex: Index, unitStrindex: Index }))
// Attribute values are read through `anyValueString`, which tolerates every shape.
const KeyValueJson = Schema.Struct({
	key: opt(Schema.String),
	keyStrindex: Index,
	value: opt(Schema.Unknown),
})

const ProfilesRequestJson = Schema.Struct({
	resourceProfiles: list(
		Schema.Struct({
			resource: opt(Schema.Struct({ attributes: list(KeyValueJson) })),
			scopeProfiles: list(
				Schema.Struct({
					profiles: list(
						Schema.Struct({
							sampleType: ValueTypeJson,
							samples: list(
								Schema.Struct({
									stackIndex: Index,
									attributeIndices: list(Schema.Int),
									linkIndex: Index,
									values: list(Int64Json),
									timestampsUnixNano: list(Int64Json),
								}),
							),
							timeUnixNano: opt(Int64Json),
							durationNano: opt(Int64Json),
							periodType: ValueTypeJson,
							period: opt(Int64Json),
							profileId: opt(Schema.String),
							attributeIndices: list(Schema.Int),
						}),
					),
				}),
			),
		}),
	),
	dictionary: opt(
		Schema.Struct({
			mappingTable: list(Schema.Struct({ filenameStrindex: Index })),
			locationTable: list(
				Schema.Struct({
					mappingIndex: Index,
					address: opt(Int64Json),
					lines: list(Schema.Struct({ functionIndex: Index, line: opt(Int64Json) })),
				}),
			),
			functionTable: list(
				Schema.Struct({
					nameStrindex: Index,
					systemNameStrindex: Index,
					filenameStrindex: Index,
					startLine: opt(Int64Json),
				}),
			),
			linkTable: list(Schema.Struct({ traceId: opt(Schema.String), spanId: opt(Schema.String) })),
			stringTable: list(Schema.String),
			attributeTable: list(Schema.Struct({ keyStrindex: Index, value: opt(Schema.Unknown) })),
			stackTable: list(Schema.Struct({ locationIndices: list(Schema.Int) })),
		}),
	),
})

/** The body as given when it has the shape `encodeProfiles` reads, else why not. */
export const checkOtlpProfilesJson = (body: unknown): Result.Result<unknown, string> =>
	Schema.decodeUnknownResult(ProfilesRequestJson)(body).pipe(
		Result.map(() => body),
		Result.mapError((error) => `invalid OTLP/JSON profiles body: ${error.message}`),
	)

/** Stacks deeper than this keep their leaf side under one `(truncated)` root. */
export const MAX_STACK_DEPTH = 256

/** A function name or file path longer than this many characters is cut: one row stays bounded. */
export const MAX_FRAME_TEXT = 1024

const clipText = (text: string): string =>
	text.length <= MAX_FRAME_TEXT ? text : Arr.join(Arr.take(Array.from(text), MAX_FRAME_TEXT), "")

const INT32_MAX = 2_147_483_647n
const INT64_MAX = 9_223_372_036_854_775_807n
const INT64_MIN = -9_223_372_036_854_775_808n

/** A line number as the Int32 column holds it; a sender's nonsense reads as unknown. */
const lineCell = (line: bigint): number => (line < 0n || line > INT32_MAX ? 0 : Number(line))

/** A window length as the UInt64 column holds it. */
const durationCell = (nanos: bigint): bigint => (nanos < 0n ? 0n : clampInt64(nanos))

const clampInt64 = (value: bigint): bigint =>
	value > INT64_MAX ? INT64_MAX : value < INT64_MIN ? INT64_MIN : value

interface ResolvedStack {
	readonly frames: string[]
	readonly files: string[]
	readonly lines: number[]
}

const toBigInt = (value: Int64 | undefined): bigint => {
	if (value === undefined || value === "") return 0n
	return typeof value === "number" ? BigInt(Math.trunc(value)) : BigInt(value)
}

/** Int64 cell: a number while it is exact, else the decimal string ClickHouse also reads. */
const int64Cell = (value: bigint): number | string =>
	value >= -9_007_199_254_740_991n && value <= 9_007_199_254_740_991n ? Number(value) : value.toString()

const baseName = (path: string): string =>
	Option.match(Str.lastIndexOf("/")(path), {
		onNone: () => path,
		onSome: (at) => Str.slice(at + 1)(path),
	})

class DictionaryReader {
	readonly #dictionary: Dictionary
	readonly #stacks = new Map<number, ResolvedStack>()

	constructor(dictionary: Dictionary | undefined) {
		this.#dictionary = dictionary ?? {}
	}

	string(index: number | undefined): string {
		return this.#dictionary.stringTable?.[index ?? 0] ?? ""
	}

	/** Since proto v1.10 a key or a string value may be a string-table index. */
	attributes(attributes: readonly ProfileKeyValue[] | undefined): Record<string, string> {
		const out: Record<string, string> = {}
		for (const attribute of attributes ?? []) {
			const key = attribute.key ? attribute.key : this.string(attribute.keyStrindex)
			out[key] = this.value(attribute.value)
		}
		return out
	}

	value(value: ProfileAnyValue | null | undefined): string {
		if (value?.stringValueStrindex !== undefined && value.stringValue === undefined)
			return this.string(value.stringValueStrindex)
		return anyValueString(value)
	}

	/** Sample and profile attributes, looked up in the dictionary's attribute table. */
	indexedAttributes(indices: readonly number[]): Record<string, string> {
		const out: Record<string, string> = {}
		for (const index of indices) {
			const entry = this.#dictionary.attributeTable?.[index]
			if (entry === undefined) continue
			const key = this.string(entry.keyStrindex)
			if (key !== "") out[key] = this.value(entry.value)
		}
		return out
	}

	link(index: number | undefined): { traceId: string; spanId: string } {
		const link = this.#dictionary.linkTable?.[index ?? 0]
		return {
			traceId: traceIdHex(link?.traceId, "link.traceId"),
			spanId: spanIdHex(link?.spanId, "link.spanId"),
		}
	}

	/** Root first. The wire runs leaf first, and a location's inlined lines run innermost first. */
	stack(index: number | undefined): ResolvedStack {
		const key = index ?? 0
		const cached = this.#stacks.get(key)
		if (cached !== undefined) return cached
		const frames: string[] = []
		const files: string[] = []
		const lines: number[] = []
		// The wire runs leaf first, so the frames kept under the cap are the leaf side. One frame
		// past the cap is enough to know the stack was cut: a hostile stack is never built whole.
		const push = (name: string, file: string, line: number): boolean => {
			frames.push(clipText(name))
			files.push(clipText(file))
			lines.push(line)
			return frames.length > MAX_STACK_DEPTH
		}
		collect: for (const locationIndex of this.#dictionary.stackTable?.[key]?.locationIndices ?? []) {
			const location = this.#dictionary.locationTable?.[locationIndex]
			if (location === undefined) continue
			if (!location.lines || location.lines.length === 0) {
				// Unsymbolized (native, eBPF): the mapping's file and the address inside it.
				const file = this.string(
					this.#dictionary.mappingTable?.[location.mappingIndex ?? 0]?.filenameStrindex,
				)
				const address = `0x${toBigInt(location.address).toString(16)}`
				if (push(file === "" ? address : `${baseName(file)}+${address}`, file, 0)) break collect
				continue
			}
			for (const line of location.lines) {
				const fn = this.#dictionary.functionTable?.[line.functionIndex ?? 0]
				const ownLine = toBigInt(line.line)
				const full =
					this.string(fn?.nameStrindex) || this.string(fn?.systemNameStrindex) || "(anonymous)"
				if (
					push(
						full,
						this.string(fn?.filenameStrindex),
						lineCell(ownLine === 0n ? toBigInt(fn?.startLine) : ownLine),
					)
				)
					break collect
			}
		}
		const isCut = frames.length > MAX_STACK_DEPTH
		if (isCut) {
			frames.length = MAX_STACK_DEPTH - 1
			files.length = MAX_STACK_DEPTH - 1
			lines.length = MAX_STACK_DEPTH - 1
		}
		frames.reverse()
		files.reverse()
		lines.reverse()
		const resolved = isCut
			? { frames: ["(truncated)", ...frames], files: ["", ...files], lines: [0, ...lines] }
			: { frames, files, lines }
		this.#stacks.set(key, resolved)
		return resolved
	}
}

interface Group {
	stack: ResolvedStack
	traceId: string
	spanId: string
	attributes: Record<string, string>
	value: bigint
	samples: number
	firstNano: bigint
}

const environmentOf = (attributes: Record<string, string>): string =>
	attributes["deployment.environment.name"] ?? attributes["deployment.environment"] ?? ""

/**
 * A producer that counts samples (the eBPF profiler: `samples`/`count` every `period` CPU
 * nanoseconds) is stored in the period's terms, so its rows sum with a time-valued producer's.
 */
const valueTerms = (
	reader: DictionaryReader,
	profile: Profile,
): { type: string; unit: string; scale: bigint } => {
	const type = reader.string(profile.sampleType?.typeStrindex)
	const unit = reader.string(profile.sampleType?.unitStrindex)
	const period = toBigInt(profile.period)
	const periodUnit = reader.string(profile.periodType?.unitStrindex)
	if (unit === "count" && periodUnit === "nanoseconds" && period > 0n)
		return {
			type: reader.string(profile.periodType?.typeStrindex) || type,
			unit: periodUnit,
			scale: period,
		}
	return { type: type === "" ? "unknown" : type, unit, scale: 1n }
}

export interface EncodedProfiles {
	readonly batches: EncodedBatch[]
	/** Profiles in the request, the unit OTLP's partial success counts. */
	readonly profileCount: number
}

/** `nowNano` stamps a profile that carries no time of its own. */
export function encodeProfiles(req: unknown, nowNano: bigint): EncodedProfiles {
	const request = (req ?? {}) as ProfilesRequest
	const reader = new DictionaryReader(request.dictionary)
	const rows: Record<string, unknown>[] = []
	let profileCount = 0

	for (const resourceProfiles of request.resourceProfiles ?? []) {
		const resourceAttributes = reader.attributes(resourceProfiles.resource?.attributes)
		for (const scopeProfiles of resourceProfiles.scopeProfiles ?? []) {
			for (const profile of scopeProfiles.profiles ?? []) {
				profileCount++
				const terms = valueTerms(reader, profile)
				const ownNano = toBigInt(profile.timeUnixNano)
				const profileNano = ownNano === 0n ? nowNano : ownNano
				const profileAttributes = reader.indexedAttributes(profile.attributeIndices ?? [])
				const groups = new Map<string, Group>()
				for (const sample of profile.samples ?? []) {
					const stack = reader.stack(sample.stackIndex)
					if (stack.frames.length === 0) continue
					const values = sample.values ?? []
					const timestamps = sample.timestampsUnixNano ?? []
					// Timestamps without values are one observation each.
					const value =
						values.length > 0
							? Arr.reduce(values, 0n, (sum, each) => sum + toBigInt(each))
							: BigInt(timestamps.length)
					const firstNano = Arr.reduce(timestamps, 0n, (first, each) => {
						const nano = toBigInt(each)
						return nano > 0n && (first === 0n || nano < first) ? nano : first
					})
					const attributeIndices = sample.attributeIndices ?? []
					const key = `${sample.stackIndex ?? 0}|${sample.linkIndex ?? 0}|${Arr.join(Arr.map(attributeIndices, String), ",")}`
					const group = groups.get(key)
					if (group === undefined) {
						const link = reader.link(sample.linkIndex)
						groups.set(key, {
							stack,
							...link,
							attributes: {
								...profileAttributes,
								...reader.indexedAttributes(attributeIndices),
							},
							value,
							samples: Math.max(values.length, timestamps.length, 1),
							firstNano,
						})
						continue
					}
					group.value += value
					group.samples += Math.max(values.length, timestamps.length, 1)
					if (firstNano > 0n && (group.firstNano === 0n || firstNano < group.firstNano))
						group.firstNano = firstNano
				}
				for (const group of groups.values()) {
					rows.push({
						timestamp: formatTimestampNano(
							(group.firstNano === 0n ? profileNano : group.firstNano).toString(),
						),
						service_name: resourceAttributes["service.name"] ?? "",
						service_version: resourceAttributes["service.version"] ?? "",
						environment: environmentOf(resourceAttributes),
						service_instance_id: resourceAttributes["service.instance.id"] ?? "",
						resource_attributes: resourceAttributes,
						profile_id: traceIdHex(profile.profileId, "profile.profileId"),
						sample_type: terms.type,
						sample_unit: terms.unit,
						value: int64Cell(clampInt64(group.value * terms.scale)),
						samples: group.samples,
						duration_nano: int64Cell(durationCell(toBigInt(profile.durationNano))),
						frames: group.stack.frames,
						frame_files: group.stack.files,
						frame_lines: group.stack.lines,
						trace_id: group.traceId,
						span_id: group.spanId,
						sample_attributes: group.attributes,
					})
				}
			}
		}
	}

	const batches =
		rows.length === 0
			? []
			: [
					{
						datasource: "profiles",
						rowCount: rows.length,
						ndjson: Arr.join(
							Arr.map(rows, (row) => encodeJson(row)),
							"\n",
						),
					},
				]
	return { batches, profileCount }
}

/** The paths the OTLP profiles export is served on: the spec's development path and the path
 *  it moves to at release candidate. */
export const PROFILES_PATHS: ReadonlySet<string> = new Set(["/v1development/profiles", "/v1/profiles"])

/** The only Profiles development version this decoder reads (absent means 1). */
export const PROFILES_DEVELOPMENT_VERSION = "1"
export const PROFILES_VERSION_HEADER = "otlp-profiles-development-version"

export const isSupportedProfilesVersion = (header: string | null): boolean =>
	header === null || Str.trim(header) === PROFILES_DEVELOPMENT_VERSION
