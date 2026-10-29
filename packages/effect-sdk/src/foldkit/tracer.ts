// The tracer the Foldkit runtime's Command spans go through. Foldkit wraps each
// Command in `Effect.withSpan(command.name, { attributes: command.args })` at
// the root of the runtime, so on their own Commands are disconnected root
// traces, one per focus move. This tracer delays creating a Command's real
// span until something needs its identity, which lets it
// - parent the Command under the navigation that caused it (the instrumented
//   `update` passes the navigation id in through the args), and
// - drop a Command that finished without starting a child span: the UI work
//   (focus, scroll, hover delays) that would otherwise flood the traces.
import { Context, Exit, Option, Tracer } from "effect"

/** Internal arg carrying a navigation id from `update` to the tracer. Never exported. */
export const NAVIGATION_ARG = "maple.foldkit.navigation_id"

type SpanOptions = Parameters<Tracer.Tracer["span"]>[0]

const MAX_EARLY_PHASES = 50

export const nowNanos = (): bigint =>
	BigInt(Math.round((performance.timeOrigin + performance.now()) * 1_000_000))

interface Navigation {
	readonly id: number
	readonly kind: "pageload" | "navigate"
	readonly route: string
	readonly path: string
	readonly startTime: bigint
	/** Set on the navigation's span when it is created. */
	readonly attributes?: Readonly<Record<string, number>> | undefined
	readonly sampled: boolean
	span: Tracer.Span | undefined
	pending: number
	/** Until its first Command starts, the navigation waits on the start grace, not the quiet period. */
	hasCommand: boolean
	lastEnd: bigint
	quietTimer: ReturnType<typeof setTimeout> | undefined
	readonly capTimer: ReturnType<typeof setTimeout>
}

export interface CommandTracingOptions {
	/** Commands that always export, even without child spans. */
	readonly keepCommands: ReadonlySet<string>
	/** Per-Command sample rates for chatty Commands outside a navigation. */
	readonly sampleRates: Readonly<Record<string, number>>
	/** Navigations sample once; every Command under one follows its decision. */
	readonly navigationSampleRate: number
	/** A navigation ends this long after its last Command, unless another starts. */
	readonly navigationQuietMs: number
	/** How long a new navigation waits for its first Command before it ends with none. */
	readonly navigationStartGraceMs: number
	readonly navigationMaxMs: number
}

export const makeFoldkitTracing = (options: CommandTracingOptions) => {
	const commandNames = new Set<string>()
	const navigations = new Map<number, Navigation>()
	let nextNavigationId = 1
	let latestNavigation: Navigation | undefined
	let inner: Tracer.Tracer | undefined
	// Phase spans reported before Foldkit builds `resources` (the first Command or Subscription).
	const earlyPhases: Array<(tracer: Tracer.Tracer) => void> = []

	const navigationSpan = (navigation: Navigation, tracer: Tracer.Tracer): Tracer.Span => {
		if (navigation.span !== undefined) return navigation.span
		const span = tracer.span({
			name: `${navigation.kind} ${navigation.route}`,
			parent: Option.none(),
			annotations: Context.empty(),
			links: [],
			startTime: navigation.startTime,
			kind: "internal",
			root: true,
			sampled: navigation.sampled,
		})
		span.attribute("url.path", navigation.path)
		for (const [key, value] of Object.entries(navigation.attributes ?? {})) span.attribute(key, value)
		navigation.span = span
		return span
	}

	/**
	 * The span to parent under: the navigation's own while it is open, or the one it ended with.
	 * A navigation that closed before any child needed a span has none to end, so none is made.
	 */
	const parentSpanOf = (
		navigation: Navigation | undefined,
		tracer: Tracer.Tracer,
	): Option.Option<Tracer.AnySpan> => {
		if (navigation === undefined) return Option.none()
		if (navigation.span !== undefined) return Option.some(navigation.span)
		return navigations.has(navigation.id)
			? Option.some(navigationSpan(navigation, tracer))
			: Option.none()
	}

	const closeNavigation = (navigation: Navigation, endTime: bigint, interrupted: boolean): void => {
		if (!navigations.has(navigation.id)) return
		navigations.delete(navigation.id)
		clearTimeout(navigation.capTimer)
		if (navigation.quietTimer !== undefined) clearTimeout(navigation.quietTimer)
		if (latestNavigation === navigation) latestNavigation = undefined
		if (navigation.span === undefined) return
		if (interrupted) navigation.span.attribute("maple.navigation.interrupted", true)
		navigation.span.end(endTime, Exit.void)
	}

	const armQuietTimer = (navigation: Navigation, delayMs: number): void => {
		if (navigation.quietTimer !== undefined) clearTimeout(navigation.quietTimer)
		navigation.quietTimer = setTimeout(
			() => closeNavigation(navigation, navigation.lastEnd, false),
			delayMs,
		)
	}

	const startNavigation = (input: {
		readonly kind: "pageload" | "navigate"
		readonly route: string
		readonly path: string
		readonly startTime: bigint
		readonly attributes?: Readonly<Record<string, number>> | undefined
	}): number => {
		const id = nextNavigationId++
		const navigation: Navigation = {
			...input,
			id,
			sampled: Math.random() < options.navigationSampleRate,
			span: undefined,
			pending: 0,
			hasCommand: false,
			lastEnd: input.startTime,
			quietTimer: undefined,
			capTimer: setTimeout(
				() => closeNavigation(navigation, nowNanos(), true),
				options.navigationMaxMs,
			),
		}
		navigations.set(id, navigation)
		latestNavigation = navigation
		// A navigation that starts no Command ends at its last phase span, not at the cap.
		armQuietTimer(navigation, options.navigationStartGraceMs)
		return id
	}

	const commandStarted = (navigation: Navigation): void => {
		navigation.pending += 1
		navigation.hasCommand = true
		if (navigation.quietTimer !== undefined) clearTimeout(navigation.quietTimer)
		navigation.quietTimer = undefined
	}

	const commandEnded = (navigation: Navigation, endTime: bigint): void => {
		navigation.pending -= 1
		if (endTime > navigation.lastEnd) navigation.lastEnd = endTime
		if (navigation.pending > 0) return
		// A Command's result Message forks its follow-up Commands right after it ends.
		armQuietTimer(navigation, options.navigationQuietMs)
	}

	class CommandSpan implements Tracer.Span {
		readonly _tag = "Span"
		readonly name: string
		readonly annotations: Context.Context<never>
		readonly kind: Tracer.SpanKind
		private real: Tracer.Span | undefined
		private navigation: Navigation | undefined
		private hasChildren = false
		private readonly buffered: Array<readonly [string, unknown]> = []

		constructor(
			private readonly tracer: Tracer.Tracer,
			private readonly options: SpanOptions,
		) {
			this.name = options.name
			this.annotations = options.annotations
			this.kind = options.kind
		}

		private materialize(): Tracer.Span {
			if (this.real !== undefined) return this.real
			const navigation = this.navigation
			const parent =
				navigation === undefined ? this.options.parent : parentSpanOf(navigation, this.tracer)
			const rate = options.sampleRates[this.name]
			const sampled =
				navigation === undefined
					? this.options.sampled && (rate === undefined || Math.random() < rate)
					: navigation.sampled
			const real = this.tracer.span({
				...this.options,
				parent,
				root: navigation === undefined || Option.isNone(parent),
				sampled,
			})
			for (const [key, value] of this.buffered) real.attribute(key, value)
			this.buffered.length = 0
			this.real = real
			return real
		}

		childStarted(): void {
			this.hasChildren = true
		}

		get spanId(): string {
			return this.materialize().spanId
		}
		get traceId(): string {
			return this.materialize().traceId
		}
		get sampled(): boolean {
			return this.materialize().sampled
		}
		get parent(): Option.Option<Tracer.AnySpan> {
			return this.materialize().parent
		}
		get status(): Tracer.SpanStatus {
			return this.real?.status ?? { _tag: "Started", startTime: this.options.startTime }
		}
		get attributes(): ReadonlyMap<string, unknown> {
			return this.real?.attributes ?? new Map(this.buffered)
		}
		get links(): ReadonlyArray<Tracer.SpanLink> {
			return this.real?.links ?? this.options.links
		}

		attribute(key: string, value: unknown): void {
			if (key === NAVIGATION_ARG) {
				const navigation = typeof value === "number" ? navigations.get(value) : undefined
				if (navigation !== undefined && this.real === undefined) {
					this.navigation = navigation
					commandStarted(navigation)
				}
				return
			}
			if (this.real !== undefined) this.real.attribute(key, value)
			else this.buffered.push([key, value])
		}
		event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void {
			this.materialize().event(name, startTime, attributes)
		}
		addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
			this.materialize().addLinks(links)
		}
		end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
			if (this.navigation !== undefined) commandEnded(this.navigation, endTime)
			const isUiOnly =
				this.real === undefined &&
				!this.hasChildren &&
				Exit.isSuccess(exit) &&
				!options.keepCommands.has(this.name)
			if (isUiOnly) return
			this.materialize().end(endTime, exit)
		}
	}

	const wrap = (tracer: Tracer.Tracer): Tracer.Tracer => {
		inner = tracer
		for (const record of earlyPhases.splice(0)) record(tracer)
		return Tracer.make({
			context: tracer.context,
			span(spanOptions) {
				if (Option.isSome(spanOptions.parent)) {
					const parent = spanOptions.parent.value
					if (parent instanceof CommandSpan) parent.childStarted()
					return tracer.span(spanOptions)
				}
				if (!commandNames.has(spanOptions.name)) return tracer.span(spanOptions)
				return new CommandSpan(tracer, spanOptions)
			},
		})
	}

	/** A finished phase span (slow `update`/`view`/patch), under the open navigation. */
	const recordPhase = (
		name: string,
		startTime: bigint,
		endTime: bigint,
		attributes: Record<string, unknown>,
	): void => {
		const navigation = latestNavigation
		if (navigation !== undefined && endTime > navigation.lastEnd) {
			navigation.lastEnd = endTime
			if (navigation.hasCommand && navigation.pending === 0)
				armQuietTimer(navigation, options.navigationQuietMs)
		}
		const record = (tracer: Tracer.Tracer): void => {
			const parent = parentSpanOf(navigation, tracer)
			const span = tracer.span({
				name,
				parent,
				annotations: Context.empty(),
				links: [],
				startTime,
				kind: "internal",
				root: Option.isNone(parent),
				// A navigation sampled out keeps its phases out even once it has closed.
				sampled: navigation?.sampled ?? true,
			})
			for (const key of Object.keys(attributes)) span.attribute(key, attributes[key])
			span.end(endTime, Exit.void)
		}
		if (inner !== undefined) return record(inner)
		if (earlyPhases.length < MAX_EARLY_PHASES) earlyPhases.push(record)
	}

	/** Ends every open navigation, e.g. when the page goes away. */
	const interruptAll = (): void => {
		for (const navigation of Array.from(navigations.values()))
			closeNavigation(navigation, nowNanos(), true)
	}

	return {
		registerCommand: (name: string): void => {
			commandNames.add(name)
		},
		startNavigation,
		wrap,
		recordPhase,
		interruptAll,
	}
}

export type FoldkitTracing = ReturnType<typeof makeFoldkitTracing>
