import { Effect, Option } from "effect"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import { fetchLatestTag, isNewer, performUpdate, stripV, UpdateError } from "../core/update"
import { bold, cyan, dim, green } from "../lib/style"
import { MAPLE_VERSION } from "../version"

const versionFlag = Flag.optional(
	Flag.string("version").pipe(
		Flag.withDescription("Install a specific release tag instead of the latest (e.g. v0.6.0)"),
	),
)

const checkFlag = Flag.boolean("check").pipe(
	Flag.withDescription("Only report whether a newer version is available; don't install"),
	Flag.withDefault(false),
)

export const update = Command.make("update", { version: versionFlag, check: checkFlag }).pipe(
	Command.withDescription(
		"Update the maple binary to the latest release (downloads, verifies the checksum, and installs in place)",
	),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const pinned = Option.getOrUndefined(a.version)
			const current = MAPLE_VERSION

			// Resolve the latest tag even when pinned isn't set, so we can compare.
			const latestTag = pinned ?? (yield* fetchLatestTag(10_000))
			const latest = stripV(latestTag)

			// `--check`: report only. Works in dev builds too (verifies the fetch).
			if (a.check) {
				const newer = isNewer(current, latestTag)
				yield* Effect.sync(() =>
					process.stderr.write(
						`  ${dim("current")} ${cyan(current)}\n` +
							`  ${dim("latest ")} ${cyan(latest)}\n` +
							(current === "dev"
								? `  ${dim("(dev build — install a release to enable updates)")}\n`
								: newer
									? `  ${green("●")} update available — run ${bold("maple update")}\n`
									: `  ${green("✓")} up to date\n`),
					),
				)
				return
			}

			// A dev build (`bun run src/bin.ts`) isn't an installed bundle to swap.
			if (current === "dev") {
				return yield* new UpdateError({
					message:
						"this is a dev build (`bun run src/bin.ts`) — install a release with the installer:\n" +
						"  curl -fsSL https://maple.dev/cli/install | sh",
				})
			}

			// No-op when already current (skipped for an explicit --version pin,
			// which may reinstall or downgrade to that exact tag).
			if (!pinned && !isNewer(current, latestTag)) {
				yield* Effect.sync(() =>
					process.stderr.write(`${green("✓")} maple is up to date ${dim(`(v${current})`)}\n`),
				)
				return
			}

			yield* Effect.sync(() => process.stderr.write(dim(`◌ updating ${current} → ${latest}…\n`)))
			const result = yield* performUpdate({ tag: latestTag })
			yield* Effect.sync(() =>
				process.stderr.write(
					`${green("✓")} updated to ${bold(stripV(result.tag))} ${dim(`(${result.installDir})`)}\n` +
						`  ${dim("restart any running")} ${bold("maple start")}\n`,
				),
			)
		}),
	),
)
