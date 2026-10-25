import { scrubUrl } from "@maple/browser-session"
import { Effect, Layer, Predicate, Tracer } from "effect"
import {
	type FlushableTelemetry,
	type MapleClientFlushableConfig,
	make as makeFlushable,
} from "../client/flushable.js"
import { type CommandArgsPolicy, makeArgsScrubber } from "./args.js"
import { makeRecentMessages, messageTag } from "./message.js"
import { type FoldkitTracing, makeFoldkitTracing, NAVIGATION_ARG, nowNanos } from "./tracer.js"

// Foldkit is typed structurally so the SDK has no dependency on it: these are
// the parts of `Runtime.makeApplication`'s config the instrumentation reads.

interface FoldkitCommand {
	readonly name: string
	readonly args?: Readonly<Record<string, unknown>> | undefined
	readonly effect: Effect.Effect<unknown, unknown, unknown>
}

interface FoldkitUpdateReturn {
	readonly model: unknown
	readonly commands?: ReadonlyArray<FoldkitCommand> | undefined
}

interface FoldkitMessage {
	readonly _tag: string
}

interface FoldkitUrl {
	readonly pathname: string
}

type SlowPhase = "Update" | "View" | "Patch" | "SubscriptionDependencies"

interface FoldkitSlowContext {
	readonly _tag: SlowPhase
	readonly durationMs: number
	readonly thresholdMs: number
	readonly message?: unknown
}

interface FoldkitCrashContext {
	readonly error: Error
	readonly message: unknown
}

type SlowThresholds = Readonly<Partial<Record<SlowPhase, number>>>

type UpdateFn = (model: never, message: never) => FoldkitUpdateReturn
type InitFn = (flags: never, url?: FoldkitUrl) => FoldkitUpdateReturn
type OnUrlChangeFn = (url: FoldkitUrl) => FoldkitMessage
type CrashReportFn = (context: FoldkitCrashContext) => void
type OnSlowFn = (context: FoldkitSlowContext) => void

/** The parts of a `Runtime.makeApplication` / `makeElement` config that `instrument` wraps. */
interface FoldkitAppConfig {
	readonly resources: Layer.Layer<unknown, unknown, unknown> | undefined
	readonly init: InitFn | undefined
	readonly update: UpdateFn | undefined
	readonly routing: object | undefined
	readonly onUrlChange: OnUrlChangeFn | undefined
	readonly crash: object | undefined
	readonly crashReport: CrashReportFn | undefined
	readonly slow: false | object | undefined
	readonly onSlow: OnSlowFn | undefined
	readonly slowThresholds: SlowThresholds | undefined
}

// BOUNDARY: the config carries the app's own Model and Message types, which the
// SDK cannot name. Only the shape Foldkit guarantees is checked here; the
// wrappers pass every value through untouched.
const isFn = <Fn>(value: unknown): value is Fn => typeof value === "function"
const field = (owner: unknown, key: string): unknown =>
	Predicate.hasProperty(owner, key) ? owner[key] : undefined
const fnField = <Fn>(owner: unknown, key: string): Fn | undefined => {
	const value = field(owner, key)
	return isFn<Fn>(value) ? value : undefined
}
const objectField = (owner: unknown, key: string): object | undefined => {
	const value = field(owner, key)
	return Predicate.isObject(value) ? value : undefined
}
const isThresholds = (value: unknown): value is SlowThresholds => Predicate.isObject(value)

const parseAppConfig = <Config extends object>(app: Config): FoldkitAppConfig => {
	const resources = field(app, "resources")
	const routing = objectField(app, "routing")
	const crash = objectField(app, "crash")
	const slow = field(app, "slow")
	const slowThresholds = field(slow, "thresholdOverrides")
	return {
		resources: Layer.isLayer(resources) ? resources : undefined,
		init: fnField<InitFn>(app, "init"),
		update: fnField<UpdateFn>(app, "update"),
		routing,
		onUrlChange: fnField<OnUrlChangeFn>(routing, "onUrlChange"),
		crash,
		crashReport: fnField<CrashReportFn>(crash, "report"),
		slow: slow === false ? false : Predicate.isObject(slow) ? slow : undefined,
		onSlow: fnField<OnSlowFn>(slow, "onSlow"),
		slowThresholds: isThresholds(slowThresholds) ? slowThresholds : undefined,
	}
}

export interface MapleFoldkitConfig extends MapleClientFlushableConfig {
	/**
	 * Which Command args become span attributes, as `maple.foldkit.arg.<key>`. Default
	 * `"ids"`: args whose key ends in `Id`/`Ids`, booleans and nulls export, every
	 * other value exports as `[redacted]`. `{ allow: ["channelId", "provider"] }` adds keys by name.
	 */
	readonly commandArgs?: CommandArgsPolicy | undefined
	/**
	 * Commands exported even when they finish without starting a child span.
	 * By default such a Command is UI work (focus, scroll, a hover delay) and is
	 * dropped, so only Commands that called an API, RPC or traced Effect export.
	 * Failed Commands always export.
	 */
	readonly keepCommands?: ReadonlyArray<string> | undefined
	/** Sample rates for chatty Commands outside a navigation, e.g. `{ SendTypingHeartbeat: 0.01 }`. */
	readonly sampleCommands?: Readonly<Record<string, number>> | undefined
	/** Share of navigations traced. Every Command under a navigation follows its decision. Default 1. */
	readonly navigationSampleRate?: number | undefined
	/**
	 * Span name suffix for a navigation, from the URL path: a route template like
	 * `/chat/:channelId` or a route name. Default: the path itself.
	 */
	readonly routeName?: ((pathname: string) => string) | undefined
	/**
	 * Report slow `update`, `view` and DOM patch phases as spans. Default
	 * thresholds: update 16ms, view 50ms, patch 50ms. `false` turns it off.
	 */
	readonly slowPhases?: false | Partial<Record<"Update" | "View" | "Patch", number>> | undefined
}

export interface MapleFoldkit extends FlushableTelemetry {
	/**
	 * Wrap a `Runtime.makeApplication` (or `makeElement`) config: merges the
	 * telemetry into `resources`, and instruments `init`, `update`, `routing`,
	 * `crash` and `slow`. Everything else passes through.
	 */
	readonly instrument: <Config extends object>(config: Config) => Config
}

/** Command args export as `maple.foldkit.arg.<key>`. */
const ARG_PREFIX = "maple.foldkit.arg."

const DEFAULT_SLOW = { Update: 16, View: 50, Patch: 50 } satisfies SlowThresholds

/** A Command's result Message remembers the navigation that caused it, so its follow-ups join it. */
const makeNavigationMarks = () => {
	const marks = new WeakMap<object, number>()
	return {
		get: (message: unknown): number | undefined =>
			Predicate.isObject(message) ? marks.get(message) : undefined,
		set: (message: unknown, id: number): void => {
			if (Predicate.isObject(message)) marks.set(message, id)
		},
	}
}

const isUpdateReturn = (value: unknown): value is FoldkitUpdateReturn => Predicate.hasProperty(value, "model")

/**
 * Maple telemetry for a Foldkit app: Command spans with navigation parents,
 * scrubbed args, crash reports and slow-phase spans, on top of the buffered
 * client tracer (`MapleFlush.make`) with session replay.
 *
 * @example
 * ```ts
 * import { MapleFoldkit } from "@maple-dev/effect-sdk/foldkit"
 *
 * const maple = MapleFoldkit.make({ serviceName: "acme-web", ingestKey: "maple_pk_..." })
 *
 * Runtime.run(Runtime.makeApplication(maple.instrument({ Model, init, update, view, resources, routing })))
 * ```
 */
export const make = (config: MapleFoldkitConfig): MapleFoldkit => {
	const tracing: FoldkitTracing = makeFoldkitTracing({
		keepCommands: new Set(config.keepCommands ?? []),
		sampleRates: config.sampleCommands ?? {},
		navigationSampleRate: config.navigationSampleRate ?? 1,
		navigationQuietMs: 150,
		navigationStartGraceMs: 1_000,
		navigationMaxMs: 30_000,
	})
	// Registered before `makeFlushable` adds its own `pagehide` flush, and in the capture phase:
	// either way it runs first, so the open navigation ends while that flush can still send it.
	const canListen = typeof globalThis.addEventListener === "function"
	if (canListen) globalThis.addEventListener("pagehide", tracing.interruptAll, { capture: true })
	const telemetry = makeFlushable(config)
	const scrubArgs = makeArgsScrubber(config.commandArgs)
	const recent = makeRecentMessages(20)
	const marks = makeNavigationMarks()
	const routeOf = (url: FoldkitUrl): string => scrubUrl(config.routeName?.(url.pathname) ?? url.pathname)

	const layer = Layer.effect(Tracer.Tracer, Effect.map(Effect.tracer, tracing.wrap)).pipe(
		Layer.provideMerge(telemetry.layer),
	)

	const instrumentCommand = (
		command: FoldkitCommand,
		tag: string,
		navigationId: number | undefined,
	): FoldkitCommand => {
		tracing.registerCommand(command.name)
		// Namespaced, so an app's `orgId` or `limit` arg never collides with a semconv or backend key.
		const args = {
			...Object.fromEntries(
				Object.entries(scrubArgs(command.args)).map(([key, value]) => [`${ARG_PREFIX}${key}`, value]),
			),
			"maple.foldkit.message": tag,
		}
		if (navigationId === undefined) return { ...command, args }
		return {
			...command,
			args: { ...args, [NAVIGATION_ARG]: navigationId },
			effect: Effect.tap(command.effect, (message) =>
				Effect.sync(() => marks.set(message, navigationId)),
			),
		}
	}

	const withCommands = <Return>(result: Return, tag: string, navigationId: number | undefined): Return => {
		if (!isUpdateReturn(result) || result.commands === undefined || result.commands.length === 0)
			return result
		return {
			...result,
			commands: result.commands.map((command) => instrumentCommand(command, tag, navigationId)),
		}
	}

	const instrumentUpdate =
		<Model, Message, Return>(update: (model: Model, message: Message) => Return) =>
		(model: Model, message: Message): Return => {
			const tag = messageTag(message)
			recent.push(tag)
			return withCommands(update(model, message), tag, marks.get(message))
		}

	const instrumentInit =
		<Flags, Return>(init: (flags: Flags, url?: FoldkitUrl) => Return) =>
		(flags: Flags, url?: FoldkitUrl): Return => {
			const navigationId =
				url === undefined
					? undefined
					: tracing.startNavigation({
							kind: "pageload",
							route: routeOf(url),
							path: scrubUrl(url.pathname),
							// The page load began at navigation start, not when the app's JS got here.
							startTime: BigInt(Math.round(performance.timeOrigin * 1_000_000)),
						})
			return withCommands(init(flags, url), "init", navigationId)
		}

	const instrumentOnUrlChange =
		<Message>(onUrlChange: (url: FoldkitUrl) => Message) =>
		(url: FoldkitUrl): Message => {
			const message = onUrlChange(url)
			const navigationId = tracing.startNavigation({
				kind: "navigate",
				route: routeOf(url),
				path: scrubUrl(url.pathname),
				startTime: nowNanos(),
			})
			marks.set(message, navigationId)
			return message
		}

	const reportCrash = (context: FoldkitCrashContext): void => {
		telemetry.captureException(context.error, {
			name: "foldkit.crash",
			attributes: {
				"maple.exception.source": "foldkit.crash",
				"maple.foldkit.message": Predicate.hasProperty(context.message, "value")
					? messageTag(context.message.value)
					: "init",
				"maple.foldkit.recent_messages": recent.read(),
			},
		})
		// The runtime has stopped; nothing else will trigger a flush.
		void telemetry.flush()
	}

	const thresholds = config.slowPhases === false ? undefined : { ...DEFAULT_SLOW, ...config.slowPhases }

	const recordSlow = (context: FoldkitSlowContext): void => {
		if (context._tag === "SubscriptionDependencies") return
		const endTime = nowNanos()
		const startTime = endTime - BigInt(Math.round(context.durationMs * 1_000_000))
		const message =
			context._tag === "Update"
				? context.message
				: Predicate.hasProperty(context.message, "value")
					? context.message.value
					: undefined
		tracing.recordPhase(`foldkit.${context._tag.toLowerCase()}`, startTime, endTime, {
			"maple.foldkit.phase": context._tag,
			"maple.foldkit.duration_ms": context.durationMs,
			"maple.foldkit.threshold_ms": context.thresholdMs,
			...(message === undefined ? undefined : { "maple.foldkit.message": messageTag(message) }),
		})
	}

	const instrument = <Config extends object>(app: Config): Config => {
		const parsed = parseAppConfig(app)
		const { init, update, onUrlChange, crashReport, onSlow } = parsed
		return {
			...app,
			resources: parsed.resources === undefined ? layer : Layer.merge(parsed.resources, layer),
			crash: {
				...parsed.crash,
				report: (context: FoldkitCrashContext) => {
					reportCrash(context)
					crashReport?.(context)
				},
			},
			...(update === undefined ? undefined : { update: instrumentUpdate(update) }),
			...(init === undefined ? undefined : { init: instrumentInit(init) }),
			...(onUrlChange === undefined
				? undefined
				: { routing: { ...parsed.routing, onUrlChange: instrumentOnUrlChange(onUrlChange) } }),
			...(thresholds === undefined || parsed.slow === false
				? undefined
				: {
						slow: {
							...parsed.slow,
							show: "Always",
							thresholdOverrides: { ...thresholds, ...parsed.slowThresholds },
							onSlow: (context: FoldkitSlowContext) => {
								recordSlow(context)
								onSlow?.(context)
							},
						},
					}),
		}
	}

	const dispose = async (): Promise<void> => {
		if (canListen) globalThis.removeEventListener("pagehide", tracing.interruptAll, { capture: true })
		// Open navigations go out with the final flush rather than ending after it.
		tracing.interruptAll()
		await telemetry.dispose()
	}

	return { ...telemetry, layer, instrument, dispose }
}
