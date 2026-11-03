import * as Command from "effect/cli/Command"
import * as Flag from "effect/cli/Flag"
import { Effect, Option, Array as Arr, String as Str } from "effect"
import { RELEASES, type ReleaseNotes, releasesBetween } from "../core/changelog"
import { stripV } from "../core/update"
import { CliUsageError } from "../lib/errors"
import { chosenFormat, printJson } from "../lib/output"
import { bold } from "../lib/style"
import { MAPLE_VERSION } from "@maple/local-server/version"

const VERSION_RE = /^v?\d+\.\d+\.\d+$/

const renderText = (releases: ReadonlyArray<ReleaseNotes>): string =>
	Arr.join(
		Arr.map(releases, (r) => `${bold(`v${r.version}`)}\n\n${r.notes}\n`),
		"\n",
	)

export const changelog = Command.make("changelog", {
	since: Flag.optional(
		Flag.String("since").pipe(
			Flag.withDescription("Show every release after this version (e.g. 0.0.20), not just this one"),
		),
	),
}).pipe(
	Command.withDescription(
		"What's new: release notes for this version of maple, or for every release since --since. " +
			"Prints text; pass --format json (or set MAPLE_FORMAT=json) for JSON.",
	),
	Command.withExamples([
		{ command: "maple changelog", description: "Notes for the installed version" },
		{ command: "maple changelog --since 0.0.20", description: "Everything that changed after 0.0.20" },
	]),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const since = Option.getOrUndefined(a.since)
			if (since !== undefined && !VERSION_RE.test(Str.trim(since))) {
				return yield* new CliUsageError({
					message: `"${since}" is not a version`,
					hint: "pass a release version like 0.0.20 or v0.0.20",
				})
			}
			const releases =
				since !== undefined
					? releasesBetween(RELEASES, Str.trim(since), MAPLE_VERSION)
					: MAPLE_VERSION === "dev"
						? RELEASES.slice(0, 1)
						: Arr.filter(RELEASES, (r) => r.version === stripV(MAPLE_VERSION))
			// Text unless JSON was asked for, by --format or MAPLE_FORMAT.
			if ((yield* chosenFormat) === "json") return yield* printJson(releases)
			yield* Effect.sync(() => {
				if (releases.length > 0) process.stdout.write(renderText(releases))
				else
					process.stderr.write(
						since !== undefined
							? `No release notes after ${stripV(Str.trim(since))}\n`
							: `No release notes for ${MAPLE_VERSION}; releases before the changelog started have none\n`,
					)
			})
		}),
	),
)
