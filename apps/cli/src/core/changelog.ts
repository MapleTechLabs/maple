// The CLI's release notes, embedded at build time from apps/cli/CHANGELOG.md,
// which the changesets "Version Packages" PR writes. Embedding means `maple
// changelog` works offline and a freshly updated binary knows its own notes.

import { Effect, Option, Array as Arr, String as Str } from "effect"
import changelogMarkdown from "../../CHANGELOG.md" with { type: "text" }
import { bold, dim, green } from "../lib/style"
import { MAPLE_VERSION } from "@maple/local-server/version"
import { MapleConfig } from "./config"
import { isNewer, shouldRunNotify, stripV } from "./update"

export interface ReleaseNotes {
	readonly version: string
	/** The version's section as written by changesets, Markdown, without its heading. */
	readonly notes: string
}

/** Each `## <version>` section, newest first as changesets writes them. */
export const parseChangelog = (markdown: string): ReadonlyArray<ReleaseNotes> =>
	Arr.filter(
		Arr.map(Str.split(/^## /m)(markdown).slice(1), (section) => {
			const newline = Str.indexOf("\n")(section)
			const heading = Option.match(newline, {
				onNone: () => section,
				onSome: (index) => Str.slice(0, index)(section),
			})
			return {
				version: stripV(Str.trim(heading)),
				notes: Option.match(newline, {
					onNone: () => "",
					onSome: (index) => Str.trim(Str.slice(index + 1)(section)),
				}),
			}
		}),
		(release) => /^\d+\.\d+\.\d+/.test(release.version),
	)

export const RELEASES: ReadonlyArray<ReleaseNotes> = parseChangelog(changelogMarkdown)

/**
 * Releases newer than `since` up to and including `current`. A dev build has
 * no version to stop at, so it gets everything newer than `since`.
 */
export const releasesBetween = (
	releases: ReadonlyArray<ReleaseNotes>,
	since: string,
	current: string,
): ReadonlyArray<ReleaseNotes> =>
	Arr.filter(
		releases,
		(r) =>
			isNewer(since, r.version) &&
			(current === "dev" || stripV(current) === r.version || isNewer(r.version, current)),
	)

/**
 * Once per upgrade, on the first interactive run of the new version: name it and
 * point at `maple changelog`. Binaries before this one never stored a version,
 * but their startup update check left `lastUpdateCheck`, so its presence marks
 * an upgrade from an unknown version; with neither it is a fresh install and
 * stays quiet. Never fails the command.
 */
export const maybeNotifyWhatsNew: Effect.Effect<void, never, MapleConfig> = Effect.gen(function* () {
	if (!shouldRunNotify(process.argv)) return
	const config = yield* MapleConfig
	const seen = Option.getOrUndefined(config.lastSeenVersion)
	if (seen === MAPLE_VERSION) return
	yield* config.write({ lastSeenVersion: MAPLE_VERSION }).pipe(Effect.ignore)
	if (process.argv[2] === "changelog") return
	const upgraded =
		seen !== undefined
			? releasesBetween(RELEASES, seen, MAPLE_VERSION).length > 0
			: Option.isSome(config.lastUpdateCheck) &&
				Arr.some(RELEASES, (r) => r.version === stripV(MAPLE_VERSION))
	if (!upgraded) return
	yield* Effect.sync(() => process.stderr.write(whatsNewHint(seen, MAPLE_VERSION)))
})

/** `from` is undefined after an upgrade from a binary that never stored its version. */
export const whatsNewHint = (from: string | undefined, to: string): string =>
	`\n${green("●")} ${bold(`updated to ${stripV(to)}`)}${from === undefined ? "" : ` ${dim(`from ${stripV(from)}`)}`}\n` +
	`  ${dim("run")} ${bold(from === undefined ? "maple changelog" : `maple changelog --since ${stripV(from)}`)} ${dim("to see what's new")}\n\n`
