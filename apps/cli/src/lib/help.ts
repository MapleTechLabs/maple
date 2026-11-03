// Effect's CLI prints the full help page to stdout before any parse error, so
// a typo'd flag buried the one line that mattered under 30 lines of help. The
// help page is held back until we know why it was requested: `--help` and a
// bare group command get it on stdout; a parse error gets `error: …` plus a
// one-line usage pointer on stderr.

import type * as Console from "effect/Console"
import * as CliOutput from "effect/cli/CliOutput"
import { Array as Arr, String as Str } from "effect"

/** `error: <message>`, with the parser's "Did you mean this?" folded into a hint line. */
export const formatParseError = (message: string): string => {
	const [head, suggestions] = Str.split(/\n\s*Did you mean this\?\s*/)(message)
	const alternatives = Arr.filter(
		Arr.map(Str.split("\n")(suggestions ?? ""), (s) => Str.trim(s)),
		(s) => s !== "",
	)
	return alternatives.length === 0
		? `error: ${Str.trim(head)}`
		: `error: ${Str.trim(head)}\nhint: did you mean ${Arr.join(alternatives, " or ")}?`
}

export const usageHint = (commandPath: ReadonlyArray<string>): string =>
	`Run '${Arr.join(commandPath, " ")} --help' for usage.\n`

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
		formatErrors: (errors) =>
			Arr.join(
				Arr.map(errors, (e) => formatParseError(e.message)),
				"\n",
			),
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
