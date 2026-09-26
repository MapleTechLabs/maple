// Effect's CLI prints the full help page to stdout before any parse error, so
// a typo'd flag buried the one line that mattered under 30 lines of help. The
// help page is held back until we know why it was requested: `--help` and a
// bare group command get it on stdout; a parse error gets `error: …` plus a
// one-line usage pointer on stderr.

import type * as Console from "effect/Console"
import * as CliOutput from "effect/unstable/cli/CliOutput"

/** `error: <message>`, with the parser's "Did you mean this?" folded into a hint line. */
export const formatParseError = (message: string): string => {
	const [head = "", suggestions] = message.split(/\n\s*Did you mean this\?\s*/)
	const alternatives = (suggestions ?? "")
		.split("\n")
		.map((s) => s.trim())
		.filter((s) => s !== "")
	return alternatives.length === 0
		? `error: ${head.trim()}`
		: `error: ${head.trim()}\nhint: did you mean ${alternatives.join(" or ")}?`
}

export const usageHint = (commandPath: ReadonlyArray<string>): string =>
	`Run '${commandPath.join(" ")} --help' for usage.\n`

export interface HelpCapture {
	readonly formatter: CliOutput.Formatter
	readonly console: Console.Console
	/** Print the held-back help page to stdout. */
	readonly flush: () => void
	/** Drop the held-back help page (it was shown because parsing failed). */
	readonly discard: () => void
}

export const makeHelpCapture = (base: CliOutput.Formatter = CliOutput.defaultFormatter()): HelpCapture => {
	let rendered: string | undefined
	let pending: Array<string> = []
	const formatter: CliOutput.Formatter = {
		...base,
		formatHelpDoc: (doc) => {
			rendered = base.formatHelpDoc(doc)
			return rendered
		},
		formatErrors: (errors) => errors.map((e) => formatParseError(e.message)).join("\n"),
	}
	const console: Console.Console = {
		...globalThis.console,
		log: (...args: ReadonlyArray<unknown>) => {
			if (rendered !== undefined && args.length === 1 && args[0] === rendered) {
				pending.push(rendered)
				return
			}
			globalThis.console.log(...args)
		},
	}
	return {
		formatter,
		console,
		flush: () => {
			for (const text of pending) process.stdout.write(`${text}\n`)
			pending = []
		},
		discard: () => {
			pending = []
		},
	}
}
