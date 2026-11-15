// BOUNDARY-FILE: This module intentionally carries opaque values; callers decode them before domain use.
// OTLP profiles (the pprof-shaped `v1development` payload) flattened to `profiles` rows: one row
// per stack, span link and attribute set per profile, the producer's samples of it summed. The
// dictionary is resolved here and never stored.
import { randomBytes } from "node:crypto"
import { Array as Arr, Option, Result, Schema, String as Str, Record as Rec } from "effect"
import { encodeJson } from "../json"
import {
	type AnyValue,
	anyValueString,
	type EncodedBatch,
	formatTimestampNano,
	spanIdHex,
	traceIdHex,
} from "./encode"

// The JSON form may spell an unset optional field as `null`, so every optional field admits it.
type Int64 = string | number
type Index = number | null

interface ProfileAnyValue extends Omit<AnyValue, "arrayValue" | "kvlistValue"> {
	stringValueStrindex?: Index
	arrayValue?: { values?: readonly (ProfileAnyValue | null)[] | null } | null
	kvlistValue?: { values?: readonly ProfileKeyValue[] | null } | null
}
interface ProfileKeyValue {
	key?: string | null
	keyStrindex?: Index
	value?: ProfileAnyValue | null
}
interface ValueType {
	typeStrindex?: Index
	unitStrindex?: Index
}
interface Sample {
	stackIndex?: Index
	attributeIndices?: number[] | null
	linkIndex?: Index
	values?: Int64[] | null
	timestampsUnixNano?: Int64[] | null
}
interface Profile {
	sampleType?: ValueType | null
	samples?: Sample[] | null
	timeUnixNano?: Int64 | null
	durationNano?: Int64 | null
	periodType?: ValueType | null
	period?: Int64 | null
	profileId?: string | null
	attributeIndices?: number[] | null
}
interface Dictionary {
	mappingTable?: { filenameStrindex?: Index }[] | null
	locationTable?:
		| {
				mappingIndex?: Index
				address?: Int64 | null
				lines?: { functionIndex?: Index; line?: Int64 | null }[] | null
		  }[]
		| null
	functionTable?:
		| {
				nameStrindex?: Index
				systemNameStrindex?: Index
				filenameStrindex?: Index
				startLine?: Int64 | null
		  }[]
		| null
	linkTable?: { traceId?: string | null; spanId?: string | null }[] | null
	stringTable?: string[] | null
	attributeTable?: { keyStrindex?: Index; value?: ProfileAnyValue | null }[] | null
	stackTable?: { locationIndices?: number[] | null }[] | null
}
export interface ProfilesRequest {
	resourceProfiles?:
		| {
				resource?: { attributes?: ProfileKeyValue[] | null } | null
				scopeProfiles?: { profiles?: Profile[] | null }[] | null
		  }[]
		| null
	dictionary?: Dictionary | null
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

/**
 * The most bytes of rows one request may flatten into. A shared dictionary makes stacks cheap
 * on the wire, so the depth and text caps bound one row and this bounds the batch.
 */
export const MAX_PROFILE_ROWS_BYTES = 64 * 1024 * 1024

/** The request's rows passed the ceiling: nothing of it is stored. The handler answers 413. */
export class ProfilesTooLarge extends Schema.TaggedError<ProfilesTooLarge>()("@maple/cli/ProfilesTooLarge", {
	message: Schema.String,
	maximumBytes: Schema.Number,
}) {}

/** The id of a profile whose producer sent none: 16 random bytes as lowercase hex. */
export const randomProfileId = (): string => randomBytes(16).toString("hex")

// A character is at most two code units, so the first `2 * MAX_FRAME_TEXT` hold every
// character kept, and a long text is never split whole into characters.
const clipText = (text: string): string =>
	text.length <= MAX_FRAME_TEXT
		? text
		: Arr.join(Arr.take(Array.from(Str.slice(0, 2 * MAX_FRAME_TEXT)(text)), MAX_FRAME_TEXT), "")

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
	/** The frame names and file paths in bytes: the least a row of this stack can weigh. */
	readonly textBytes: number
}

const textBytesOf = (texts: readonly string[]): number =>
	Arr.reduce(texts, 0, (sum, text) => sum + Buffer.byteLength(text))

const toBigInt = (value: Int64 | null | undefined): bigint => {
	if (value === undefined || value === null || value === "") return 0n
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
	readonly #maximumBytes: number
	/**
	 * Attribute text the whole request may still resolve. Nearly all of it is written to rows, so
	 * twice the row ceiling is room for a sample's value replacing its profile's, and past it the
	 * rows could not fit anyway.
	 */
	#textLeft: number

	constructor(dictionary: Dictionary | null | undefined, maximumBytes: number) {
		this.#dictionary = dictionary ?? {}
		this.#maximumBytes = maximumBytes
		this.#textLeft = 2 * maximumBytes
	}

	string(index: Index | undefined): string {
		return this.#dictionary.stringTable?.[index ?? 0] ?? ""
	}

	/** Since proto v1.10 a key or a string value may be a string-table index. */
	attributes(attributes: readonly ProfileKeyValue[] | null | undefined): Record<string, string> {
		const out: Record<string, string> = {}
		for (const attribute of attributes ?? [])
			out[this.#spend(this.#key(attribute))] = this.value(attribute.value)
		return out
	}

	#key(attribute: ProfileKeyValue): string {
		return attribute.key ? attribute.key : this.string(attribute.keyStrindex)
	}

	/**
	 * The value's text. Throws `ProfilesTooLarge` once the request's attributes resolve past their
	 * budget: an array of references to one large entry is a few wire bytes and gigabytes of text,
	 * so text is counted as each string resolves, before anything is serialized.
	 */
	value(value: ProfileAnyValue | null | undefined): string {
		return anyValueString(this.#inline(value))
	}

	/**
	 * Counts `text` against the request's budget; its length in code units is never more than its
	 * bytes. A field that should be a string but is not counts as its string form, never as nothing.
	 */
	#spend<T>(text: T): T {
		this.#textLeft -= typeof text === "string" ? text.length : String(text ?? "").length
		if (!(this.#textLeft >= 0))
			throw new ProfilesTooLarge({
				message: `the profiles' attributes resolve to more than ${2 * this.#maximumBytes} bytes of text`,
				maximumBytes: this.#maximumBytes,
			})
		return text
	}

	/** The value as if its strings were sent inline: references resolved at every depth. */
	#inline(value: ProfileAnyValue | null | undefined): AnyValue {
		if (value === null || value === undefined) return {}
		const { stringValueStrindex, arrayValue, kvlistValue, ...scalars } = value
		if (scalars.stringValue !== undefined && scalars.stringValue !== null)
			this.#spend(scalars.stringValue)
		if (
			scalars.stringValue === undefined &&
			stringValueStrindex !== undefined &&
			stringValueStrindex !== null
		)
			return { stringValue: this.#spend(this.string(stringValueStrindex)) }
		if (arrayValue)
			return {
				...scalars,
				arrayValue: {
					values: Arr.map(arrayValue.values ?? [], (each) => this.#inline(each)),
				},
			}
		if (kvlistValue)
			return {
				...scalars,
				kvlistValue: {
					values: Arr.map(kvlistValue.values ?? [], (each) => ({
						key: this.#spend(this.#key(each)),
						value: this.#inline(each.value),
					})),
				},
			}
		return scalars
	}

	/** Sample and profile attributes, looked up in the dictionary's attribute table. */
	indexedAttributes(indices: readonly number[]): Record<string, string> {
		const out: Record<string, string> = {}
		for (const index of indices) {
			const entry = this.#dictionary.attributeTable?.[index]
			if (entry === undefined) continue
			const key = this.#spend(this.string(entry.keyStrindex))
			if (key !== "") out[key] = this.value(entry.value)
		}
		return out
	}

	link(index: Index | undefined): { traceId: string; spanId: string } {
		const link = this.#dictionary.linkTable?.[index ?? 0]
		return {
			traceId: traceIdHex(link?.traceId ?? undefined, "link.traceId"),
			spanId: spanIdHex(link?.spanId ?? undefined, "link.spanId"),
		}
	}

	/** Root first. The wire runs leaf first, and a location's inlined lines run innermost first. */
	stack(index: Index | undefined): ResolvedStack {
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
		const textBytes = textBytesOf(frames) + textBytesOf(files)
		const resolved = isCut
			? { frames: ["(truncated)", ...frames], files: ["", ...files], lines: [0, ...lines], textBytes }
			: { frames, files, lines, textBytes }
		this.#stacks.set(key, resolved)
		return resolved
	}
}

interface Group {
	stack: ResolvedStack
	traceId: string
	spanId: string
	/** The sample's own attributes; the profile's are merged in as the row is written. */
	attributes: Record<string, string>
	value: bigint
	samples: number
	firstNano: bigint
}

/** What an attribute map takes in a row at least: its keys and values, before quoting. */
const attributesWeight = (attributes: Record<string, string>): number =>
	Arr.reduce(Rec.toEntries(attributes), 0, (sum, [key, value]) => sum + key.length + value.length)

/** What a sample's own attributes add to a row: a key it shares with the profile replaces that entry. */
const ownAttributesWeight = (own: Record<string, string>, profile: Record<string, string>): number =>
	Arr.reduce(Rec.toEntries(own), 0, (sum, [key, value]) => {
		const replaced = profile[key]
		return sum + key.length + value.length - (replaced === undefined ? 0 : key.length + replaced.length)
	})

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

/**
 * `nowNano` stamps a profile that carries no time of its own, `newProfileId` names one that
 * carries no id. Throws `ProfilesTooLarge` once the rows pass `maximumRowBytes`.
 */
export function encodeProfiles(
	req: unknown,
	nowNano: bigint,
	newProfileId: () => string = randomProfileId,
	maximumRowBytes: number = MAX_PROFILE_ROWS_BYTES,
): EncodedProfiles {
	const request = (req ?? {}) as ProfilesRequest
	const reader = new DictionaryReader(request.dictionary, maximumRowBytes)
	const lines: string[] = []
	// The NDJSON's size, counted as each row is written: the whole is never built to be measured.
	let rowBytes = 0
	const checkCeiling = (bytes: number): void => {
		if (bytes > maximumRowBytes)
			throw new ProfilesTooLarge({
				message: `the profiles flatten into more than ${maximumRowBytes} bytes of rows`,
				maximumBytes: maximumRowBytes,
			})
	}
	let profileCount = 0

	for (const resourceProfiles of request.resourceProfiles ?? []) {
		const resourceAttributes = reader.attributes(resourceProfiles.resource?.attributes)
		const resourceWeight = attributesWeight(resourceAttributes)
		for (const scopeProfiles of resourceProfiles.scopeProfiles ?? []) {
			for (const profile of scopeProfiles.profiles ?? []) {
				profileCount++
				const terms = valueTerms(reader, profile)
				const ownNano = toBigInt(profile.timeUnixNano)
				const profileNano = ownNano === 0n ? nowNano : ownNano
				const profileAttributes = reader.indexedAttributes(profile.attributeIndices ?? [])
				// Every row repeats the resource's and the profile's attributes.
				const sharedWeight = resourceWeight + attributesWeight(profileAttributes)
				const groups = new Map<string, Group>()
				// What this profile's rows weigh at least, so a profile that cannot fit stops
				// before its stacks are all resolved and held.
				let heldBytes = 0
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
						const attributes = reader.indexedAttributes(attributeIndices)
						heldBytes +=
							stack.textBytes +
							sharedWeight +
							ownAttributesWeight(attributes, profileAttributes)
						checkCeiling(rowBytes + heldBytes)
						groups.set(key, {
							stack,
							...link,
							attributes,
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
				if (groups.size === 0) continue
				// Rows of one profile share its id, so profiles without one must not share "".
				const profileId =
					traceIdHex(profile.profileId ?? undefined, "profile.profileId") || newProfileId()
				for (const group of groups.values()) {
					const line = encodeJson({
						timestamp: formatTimestampNano(
							(group.firstNano === 0n ? profileNano : group.firstNano).toString(),
						),
						service_name: resourceAttributes["service.name"] ?? "",
						service_version: resourceAttributes["service.version"] ?? "",
						environment: environmentOf(resourceAttributes),
						service_instance_id: resourceAttributes["service.instance.id"] ?? "",
						resource_attributes: resourceAttributes,
						profile_id: profileId,
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
						sample_attributes: { ...profileAttributes, ...group.attributes },
					})
					rowBytes += Buffer.byteLength(line) + (lines.length === 0 ? 0 : 1)
					checkCeiling(rowBytes)
					lines.push(line)
				}
			}
		}
	}

	const batches =
		lines.length === 0
			? []
			: [{ datasource: "profiles", rowCount: lines.length, ndjson: Arr.join(lines, "\n") }]
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
