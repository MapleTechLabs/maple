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
	readonly startedAt: number
}

export interface StepHandle {
	/** Report bytes transferred so far; switches the line to a progress bar. */
	readonly transfer: (received: number, total: number | undefined) => Effect.Effect<void>
}

const transferSuffix = (t: Transfer, now: number): string => {
	const elapsed = Math.max(1, now - t.startedAt) / 1000
	const rate = `${formatBytes(Math.round(t.received / elapsed))}/s`
	if (t.total === undefined || t.total <= 0) {
		return `  ${dim(`${formatBytes(t.received)}  ${rate}`)}`
	}
	const fraction = t.received / t.total
	const pct = `${Math.floor(fraction * 100)}%`.padStart(4)
	return `  ${progressBar(fraction)} ${bold(pct)}  ${dim(`${formatBytes(t.received)} / ${formatBytes(t.total)}  ${rate}`)}`
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
		const transfer = yield* Ref.make(Option.none<Transfer>())
		const handle: StepHandle = {
			transfer: (received, total) =>
				Effect.flatMap(Clock.currentTimeMillis, (now) =>
					Ref.update(transfer, (prev) =>
						Option.some({
							received,
							total,
							startedAt: Option.match(prev, { onNone: () => now, onSome: (p) => p.startedAt }),
						}),
					),
				),
		}

		const draw = Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis
			const frame = SPINNER[Math.floor(now / FRAME_MS) % SPINNER.length] ?? SPINNER[0]
			const t = yield* Ref.get(transfer)
			const suffix = Option.match(t, { onNone: () => "", onSome: (x) => transferSuffix(x, now) })
			yield* write(`${CLEAR_LINE}  ${amber(frame)} ${label}${suffix}`)
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
						` ${dim(`${formatBytes(t.total ?? t.received)} in ${((now - t.startedAt) / 1000).toFixed(1)}s`)}`,
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
