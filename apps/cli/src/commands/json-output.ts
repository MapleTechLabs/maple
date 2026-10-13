import { Effect } from "effect"

/**
 * Whether the global `--format json` was given explicitly. That flag defaults
 * to json for the query commands, so the store and archive commands, whose
 * default is human-readable, switch only when it is actually on the command
 * line. Read from argv like `--debug`, since the root's parsed flags are not
 * reachable from a subcommand module without an import cycle.
 */
export const jsonFormatRequested = (argv: ReadonlyArray<string> = process.argv): boolean => {
	const index = argv.indexOf("--format")
	return (index >= 0 && argv[index + 1] === "json") || argv.includes("--format=json")
}

export const writeJson = (value: unknown): Effect.Effect<void> =>
	Effect.sync(() => {
		process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
	})
