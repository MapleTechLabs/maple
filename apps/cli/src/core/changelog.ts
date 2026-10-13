// The CLI's release notes, embedded at build time from apps/cli/CHANGELOG.md,
// which the changesets "Version Packages" PR writes. Embedding means `maple
// changelog` works offline and a freshly updated binary knows its own notes.

import { Effect, Option } from "effect"
import changelogMarkdown from "../../CHANGELOG.md" with { type: "text" }
import { bold, dim, green } from "../lib/style"
import { MAPLE_VERSION } from "../version"
import { MapleConfig } from "./config"
import { isNewer, shouldRunNotify, stripV } from "./update"

export interface ReleaseNotes {
	readonly version: string
	/** The version's section as written by changesets, Markdown, without its heading. */
	readonly notes: string
}

/** Each `## <version>` section, newest first as changesets writes them. */
export const parseChangelog = (markdown: string): ReadonlyArray<ReleaseNotes> =>
	markdown
		.split(/^## /m)
		.slice(1)
		.map((section) => {
			const newline = section.indexOf("\n")
			const heading = newline === -1 ? section : section.slice(0, newline)
			return {
				version: stripV(heading.trim()),
				notes: newline === -1 ? "" : section.slice(newline + 1).trim(),
			}
		})
		.filter((release) => /^\d+\.\d+\.\d+/.test(release.version))

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
	releases.filter(
		(r) =>
			isNewer(since, r.version) &&
			(current === "dev" || stripV(current) === r.version || isNewer(r.version, current)),
	)

/**
 * Once per upgrade, on the first interactive run of the new version: name it and
 * point at `maple changelog`. A machine's first recorded run only stores the
 * version, so a fresh install stays quiet. Never fails the command.
 */
export const maybeNotifyWhatsNew: Effect.Effect<void, never, MapleConfig> = Effect.gen(function* () {
	if (!shouldRunNotify(process.argv)) return
	const config = yield* MapleConfig
	const seen = Option.getOrUndefined(config.lastSeenVersion)
	if (seen === MAPLE_VERSION) return
	yield* config.write({ lastSeenVersion: MAPLE_VERSION }).pipe(Effect.ignore)
	if (seen === undefined || process.argv[2] === "changelog") return
	if (releasesBetween(RELEASES, seen, MAPLE_VERSION).length === 0) return
	yield* Effect.sync(() => process.stderr.write(whatsNewHint(seen, MAPLE_VERSION)))
})

export const whatsNewHint = (from: string, to: string): string =>
	`\n${green("●")} ${bold(`updated to ${stripV(to)}`)} ${dim(`from ${stripV(from)}`)}\n` +
	`  ${dim("run")} ${bold(`maple changelog --since ${stripV(from)}`)} ${dim("to see what's new")}\n\n`
