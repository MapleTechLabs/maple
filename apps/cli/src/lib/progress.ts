// Live step list for long-running commands on stderr. On a TTY the running step
// is a spinner line (with an optional byte progress bar) redrawn in place and
// replaced by ✓/✗ when it settles; elsewhere only the settled lines print.
import { Cause, Clock, Effect, Exit, Fiber, Option, Ref, Schedule } from "effect"
import { amber, bold, dim, green, red } from "./style"

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const
const FRAME_MS = 80
const BAR_WIDTH = 24

const live = process.stderr.isTTY === true && !process.env.CI
const write = (s: string) => Effect.sync(() => process.stderr.write(s))
const CLEAR_LINE = "\r\x1b[2K"
const HIDE_CURSOR = "\x1b[?25l"
const SHOW_CURSOR = "\x1b[?25h"

export const formatBytes = (n: number): string => {
	if (n < 1024) return `${n} B`
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
	return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** `█████░░░░` for a 0..1 fraction; partial cells use eighth blocks so slow
 *  downloads still visibly advance. */
export const progressBar = (fraction: number, width = BAR_WIDTH): string => {
	const clamped = Math.min(1, Math.max(0, fraction))
	const eighths = Math.round(clamped * width * 8)
	const full = Math.floor(eighths / 8)
	const partial = eighths % 8
	const partialChar = partial === 0 ? "" : (["▏", "▎", "▍", "▌", "▋", "▊", "▉"][partial - 1] ?? "")
	const rest = width - full - (partialChar ? 1 : 0)
	return amber("█".repeat(full) + partialChar) + dim("░".repeat(rest))
}

interface Transfer {
	readonly received: number
	readonly total: number | undefined
}

export interface StepHandle {
	/** Report bytes transferred so far; switches the line to a progress bar. */
	readonly transfer: (received: number, total: number | undefined) => Effect.Effect<void>
}

/** Transfer suffixes from richest to plainest; the redraw takes the first that
 *  fits, since a wrapped line leaves rows `CLEAR_LINE` cannot reach. */
const transferSuffixes = (t: Transfer, elapsedMs: number): ReadonlyArray<string> => {
	const rate = `${formatBytes(Math.round(t.received / (Math.max(1, elapsedMs) / 1000)))}/s`
	if (t.total === undefined || t.total <= 0) {
		return [`  ${dim(`${formatBytes(t.received)}  ${rate}`)}`, `  ${dim(formatBytes(t.received))}`, ""]
	}
	const fraction = t.received / t.total
	const pct = bold(`${Math.floor(fraction * 100)}%`.padStart(4))
	return [
		`  ${progressBar(fraction)} ${pct}  ${dim(`${formatBytes(t.received)} / ${formatBytes(t.total)}  ${rate}`)}`,
		`  ${progressBar(fraction)} ${pct}`,
		`  ${progressBar(fraction, 10)} ${pct}`,
		` ${pct}`,
		"",
	]
}

/** The running line, kept narrower than the terminal so it never wraps. */
export const fitLine = (
	head: string,
	label: string,
	suffixes: ReadonlyArray<string>,
	columns: number,
): string => {
	const base = `${head}${label}`
	const fit = suffixes.find((suffix) => Bun.stringWidth(base + suffix) < columns)
	if (fit !== undefined) return base + fit
	const room = Math.max(1, columns - 1 - Bun.stringWidth(head))
	return label.length > room ? `${head}${label.slice(0, Math.max(0, room - 1))}…` : base
}

export interface StepLabels {
	/** Shown beside the spinner, e.g. "Downloading bundle". */
	readonly running: string
	/** Shown beside the ✓, e.g. "Downloaded bundle". */
	readonly done: string
}

/** Run `body` as one step. A step that reported a transfer settles with its
 *  size and duration, e.g. `✓ Downloaded bundle 24.1 MB in 3.2s`. */
export const step = <A, E, R>(
	labels: StepLabels,
	body: (handle: StepHandle) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
	Effect.gen(function* () {
		const label = labels.running
		// Timed from the step's start, so a slow first byte counts toward the
		// elapsed time and the rate.
		const startedAt = yield* Clock.currentTimeMillis
		const transfer = yield* Ref.make(Option.none<Transfer>())
		const handle: StepHandle = {
			transfer: (received, total) => Ref.set(transfer, Option.some({ received, total })),
		}

		const draw = Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			const frame = SPINNER[Math.floor(now / FRAME_MS) % SPINNER.length] ?? SPINNER[0]
			const suffixes = Option.match(yield* Ref.get(transfer), {
				onNone: () => [""],
				onSome: (t) => transferSuffixes(t, now - startedAt),
			})
			const columns = process.stderr.columns ?? 80
			yield* write(`${CLEAR_LINE}${fitLine(`  ${amber(frame)} `, label, suffixes, columns)}`)
		})

		const ticker = live
			? Option.some(
					yield* write(HIDE_CURSOR).pipe(
						Effect.andThen(Effect.repeat(draw, Schedule.spaced(FRAME_MS))),
						Effect.forkChild,
					),
				)
			: Option.none()

		const settle = (exit: Exit.Exit<A, E>) =>
			Effect.gen(function* () {
				if (Option.isSome(ticker)) yield* Fiber.interrupt(ticker.value)
				const prefix = live ? CLEAR_LINE : ""
				const now = yield* Clock.currentTimeMillis
				const detail = Option.match(yield* Ref.get(transfer), {
					onNone: () => "",
					onSome: (t) =>
						` ${dim(`${formatBytes(t.total ?? t.received)} in ${((now - startedAt) / 1000).toFixed(1)}s`)}`,
				})
				const line = Exit.isSuccess(exit)
					? `${green("✓")} ${labels.done}${detail}`
					: Cause.hasInterruptsOnly(exit.cause)
						? `${dim("○")} ${dim(`${label} (cancelled)`)}`
						: `${red("✗")} ${label}`
				yield* write(`${prefix}  ${line}\n${live ? SHOW_CURSOR : ""}`)
			})

		return yield* body(handle).pipe(Effect.onExit(settle))
	})
