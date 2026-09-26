import { Effect, Option } from "effect"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import { releaseSignatureNotice } from "../core/release-signature"
import { fetchLatestTag, isNewer, performUpdate, stripV, UpdateError } from "../core/update"
import { amber, bold, cyan, dim, green } from "../lib/style"
import { MAPLE_VERSION } from "../version"

// NB: this is named `--tag`, not `--version`: the CLI framework reserves a
// global `--version` flag (prints the binary version and exits), so a
// command-level `--version` would be shadowed and never reach the handler.
const tagFlag = Flag.optional(
	Flag.String("tag").pipe(
		Flag.withDescription("Install a specific release tag instead of the latest (e.g. v0.6.0)"),
	),
)

const checkFlag = Flag.Boolean("check").pipe(
	Flag.withDescription("Only report whether a newer version is available; don't install"),
	Flag.withDefault(false),
)

const insecureSkipSignatureFlag = Flag.Boolean("insecure-skip-signature").pipe(
	Flag.withDescription(
		"Install even if the release signature is missing or invalid (the SHA-256 checksum is still checked)",
	),
	Flag.withDefault(false),
)

export const update = Command.make("update", {
	tag: tagFlag,
	check: checkFlag,
	insecureSkipSignature: insecureSkipSignatureFlag,
}).pipe(
	Command.withDescription(
		"Update the maple binary to the latest release (downloads, verifies the signature and checksum, and installs in place)",
	),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const pinned = Option.getOrUndefined(a.tag)
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
								? `  ${dim("(dev build; install a release to enable updates)")}\n`
								: newer
									? `  ${green("●")} update available: run ${bold("maple update")}\n`
									: `  ${green("✓")} up to date\n`),
					),
				)
				return
			}

			// A dev build (`bun run src/bin.ts`) isn't an installed bundle to swap.
			if (current === "dev") {
				return yield* new UpdateError({
					message:
						"this is a dev build (`bun run src/bin.ts`); install a release with the installer:\n" +
						"  curl -fsSL https://maple.dev/cli/install | sh",
				})
			}

			// No-op when already current (skipped for an explicit --tag pin,
			// which may reinstall or downgrade to that exact tag).
			if (!pinned && !isNewer(current, latestTag)) {
				yield* Effect.sync(() =>
					process.stderr.write(`${green("✓")} maple is up to date ${dim(`(v${current})`)}\n`),
				)
				return
			}

			yield* Effect.sync(() => process.stderr.write(dim(`◌ updating ${current} → ${latest}…\n`)))
			const result = yield* performUpdate({
				tag: latestTag,
				skipSignature: a.insecureSkipSignature,
			})
			const notice = releaseSignatureNotice(result.signature)
			yield* Effect.sync(() =>
				process.stderr.write(
					`${green("✓")} updated to ${bold(stripV(result.tag))} ${dim(`(${result.installDir})`)}\n` +
						(notice ? `  ${amber("!")} ${dim(notice)}\n` : "") +
						`  ${dim("restart any running")} ${bold("maple start")}\n`,
				),
			)
		}),
	),
)
