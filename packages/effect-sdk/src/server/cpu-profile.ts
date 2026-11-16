// A V8-format CPU profile (what `node:inspector`'s `Profiler.stop` returns on Node and Bun)
// as an OTLP profiles export: samples folded per call stack and per span, in the pprof-shaped
// `v1development` dictionary form.
import { Array as Arr, String as Str } from "effect"
import { type SpanEvents, spanAt } from "../shared/span-timeline.js"

/** The inspector protocol's `Profiler.Profile`, as far as this reads it. */
export interface CpuProfile {
	readonly nodes: ReadonlyArray<{
		readonly id: number
		readonly callFrame: {
			readonly functionName: string
			readonly url: string
			readonly lineNumber: number
		}
		readonly children?: ReadonlyArray<number> | undefined
	}>
	/** Microseconds on the profiler's own clock. */
	readonly startTime: number
	readonly samples?: ReadonlyArray<number> | undefined
	/** Microseconds between consecutive samples; the first is from `startTime`. */
	readonly timeDeltas?: ReadonlyArray<number> | undefined
}

export interface EncodeCpuProfileOptions {
	/** The OTLP/JSON resource the other signals send. */
	readonly resource: unknown
	/** `performance.now()` read just before the profiler started: where `startTime` sits. */
	readonly startedAtPerfMs: number
	/** Wall clock at the same moment. */
	readonly startedAtEpochMs: number
	/** How long the profiler ran. */
	readonly durationMs: number
	readonly samplingIntervalMicros: number
	/** Span switches over the window; without them samples carry no span link. */
	readonly spanEvents?: SpanEvents | undefined
	/** 16 random bytes as hex. */
	readonly profileId: string
}

/** The body of `POST /v1development/profiles`, OTLP/JSON. */
export interface ProfilesExport {
	readonly resourceProfiles: ReadonlyArray<unknown>
	readonly dictionary: unknown
}

// Not CPU: the runtime waiting for work.
const IDLE = "(idle)"
// The profiler's own tree root, which is not a frame of the program.
const ROOT = "(root)"

const FILE_SCHEME = "file://"
const isFileUrl = Str.startsWith(FILE_SCHEME)
const withoutFileScheme = Str.slice(FILE_SCHEME.length)

const nanos = (epochMs: number): string => (BigInt(Math.round(epochMs * 1000)) * 1000n).toString()

class Interner<T> {
	readonly table: Array<T>
	readonly #index = new Map<string, number>()

	// Index 0 of every dictionary table is its zero value, which reads as "none".
	constructor(zero: T) {
		this.table = [zero]
	}

	intern(key: string, make: () => T): number {
		const existing = this.#index.get(key)
		if (existing !== undefined) return existing
		const index = this.table.length
		this.table.push(make())
		this.#index.set(key, index)
		return index
	}
}

interface Group {
	readonly nodeId: number
	readonly linkIndex: number
	valueNanos: number
	firstEpochMs: number
}

/**
 * `undefined` when the window holds no on-CPU sample (an idle process), so nothing is sent.
 *
 * A sample's time is the gap to the next one, capped at one interval: a runtime that stops
 * sampling while idle (Bun) would otherwise bill the idle gap after a burst to its last stack.
 */
export const encodeCpuProfile = (
	profile: CpuProfile,
	options: EncodeCpuProfileOptions,
): ProfilesExport | undefined => {
	const samples = profile.samples ?? []
	const deltas = profile.timeDeltas ?? []
	const nodes = new Map(Arr.map(profile.nodes, (node) => [node.id, node]))
	const parents = new Map<number, number>()
	for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id)

	const strings = new Interner<string>("")
	const string = (value: string): number => (value === "" ? 0 : strings.intern(value, () => value))
	const functions = new Interner<Record<string, number>>({})
	const locations = new Interner<Record<string, unknown>>({})
	const stacks = new Interner<Record<string, unknown>>({})
	const links = new Interner<Record<string, string>>({})

	const locationOf = (nodeId: number): number | undefined => {
		const frame = nodes.get(nodeId)?.callFrame
		if (frame === undefined || frame.functionName === ROOT) return undefined
		const file = isFileUrl(frame.url) ? withoutFileScheme(frame.url) : frame.url
		// V8 lines are zero-based; -1 marks a frame with no source position.
		const line = frame.lineNumber >= 0 ? frame.lineNumber + 1 : 0
		const key = `${frame.functionName}\u0000${file}\u0000${line}`
		return locations.intern(key, () => ({
			lines: [
				{
					functionIndex: functions.intern(key, () => ({
						nameStrindex: string(frame.functionName === "" ? "(anonymous)" : frame.functionName),
						filenameStrindex: string(file),
						startLine: line,
					})),
					line,
				},
			],
		}))
	}

	// Leaf first, as the wire wants it.
	const stackOf = (nodeId: number): number =>
		stacks.intern(String(nodeId), () => {
			const locationIndices: Array<number> = []
			for (
				let current: number | undefined = nodeId;
				current !== undefined;
				current = parents.get(current)
			) {
				const location = locationOf(current)
				if (location !== undefined) locationIndices.push(location)
			}
			return { locationIndices }
		})

	const maxSampleMicros = options.samplingIntervalMicros
	const groups = new Map<string, Group>()
	let elapsedMicros = 0
	for (let index = 0; index < samples.length; index++) {
		elapsedMicros += deltas[index] ?? 0
		const nodeId = samples[index]
		if (nodeId === undefined || nodes.get(nodeId)?.callFrame.functionName === IDLE) continue
		const valueMicros = Math.min(
			Math.max(deltas[index + 1] ?? options.samplingIntervalMicros, 0),
			maxSampleMicros,
		)
		const offsetMs = elapsedMicros / 1000
		const span =
			options.spanEvents === undefined
				? undefined
				: spanAt(options.spanEvents, options.startedAtPerfMs + offsetMs)
		const linkIndex =
			span === undefined
				? 0
				: links.intern(span.spanId, () => ({ traceId: span.traceId, spanId: span.spanId }))
		const key = `${nodeId}|${linkIndex}`
		const group = groups.get(key)
		if (group === undefined)
			groups.set(key, {
				nodeId,
				linkIndex,
				valueNanos: valueMicros * 1000,
				firstEpochMs: options.startedAtEpochMs + offsetMs,
			})
		else group.valueNanos += valueMicros * 1000
	}
	if (groups.size === 0) return undefined

	const cpu = { typeStrindex: string("cpu"), unitStrindex: string("nanoseconds") }
	const profileSamples = Arr.map([...groups.values()], (group) => ({
		stackIndex: stackOf(group.nodeId),
		linkIndex: group.linkIndex,
		values: [String(group.valueNanos)],
		timestampsUnixNano: [nanos(group.firstEpochMs)],
	}))

	return {
		resourceProfiles: [
			{
				resource: options.resource,
				scopeProfiles: [
					{
						scope: { name: "@maple-dev/effect-sdk/profiling" },
						profiles: [
							{
								sampleType: cpu,
								samples: profileSamples,
								timeUnixNano: nanos(options.startedAtEpochMs),
								durationNano: String(Math.round(options.durationMs * 1_000_000)),
								periodType: cpu,
								period: String(options.samplingIntervalMicros * 1000),
								profileId: options.profileId,
							},
						],
					},
				],
			},
		],
		dictionary: {
			mappingTable: [{}],
			locationTable: locations.table,
			functionTable: functions.table,
			linkTable: links.table,
			stringTable: strings.table,
			attributeTable: [{}],
			stackTable: stacks.table,
		},
	}
}
