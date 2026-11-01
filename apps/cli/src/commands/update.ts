import { Effect, Option, Ref } from "effect"
import * as Command from "effect/cli/Command"
import * as Flag from "effect/cli/Flag"
import { MapleConfig } from "../core/config"
import { releaseSignatureNotice } from "../core/release-signature"
import {
	fetchLatestTag,
	isNewer,
	performUpdate,
	stripV,
	UpdateError,
	type UpdateProgress,
	type UpdateStage,
} from "../core/update"
import { step, type StepHandle, type StepLabels } from "../lib/progress"
import { amber, bold, cyan, dim, green } from "../lib/style"
import { MAPLE_VERSION } from "@maple/local-server/version"

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

const STAGE_LABELS = {
	verify: { running: "Checking release manifest", done: "Release manifest checked" },
	download: { running: "Downloading bundle", done: "Downloaded bundle" },
	checksum: { running: "Verifying checksum", done: "Checksum verified" },
	extract: { running: "Unpacking", done: "Unpacked" },
	install: { running: "Installing", done: "Installed" },
} satisfies Record<UpdateStage, StepLabels>

/** Renders each `performUpdate` stage as a live step; download bytes go to
 *  whichever step is currently running. */
const stepProgress = Effect.gen(function* () {
	const current = yield* Ref.make(Option.none<StepHandle>())
	const progress: UpdateProgress = {
		stage: (stage, effect) =>
			step(STAGE_LABELS[stage], (handle) =>
				Ref.set(current, Option.some(handle)).pipe(Effect.andThen(effect)),
			),
		downloaded: (received, total) =>
			Effect.flatMap(Ref.get(current), (handle) =>
				Option.match(handle, {
					onNone: () => Effect.void,
					onSome: (h) => h.transfer(received, total),
				}),
			),
	}
	return progress
})

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

			yield* Effect.sync(() =>
				process.stderr.write(`\n  ${bold("maple")} ${dim(current)} ${dim("→")} ${green(latest)}\n\n`),
			)
			const result = yield* performUpdate({
				tag: latestTag,
				skipSignature: a.insecureSkipSignature,
				progress: yield* stepProgress,
			})
			const notice = releaseSignatureNotice(result.signature)
			yield* Effect.sync(() =>
				process.stderr.write(
					`\n${green("✓")} updated to ${bold(stripV(result.tag))} ${dim(`(${result.installDir})`)}\n` +
						(notice ? `  ${amber("!")} ${dim(notice)}\n` : "") +
						`  ${dim("restart any running")} ${bold("maple start")}\n` +
						// A pinned --tag can downgrade; there is nothing new to read then.
						(isNewer(current, result.tag)
							? `  ${dim("see what's new:")} ${bold(`maple changelog --since ${current}`)}\n`
							: ""),
				),
			)
			// The hint above already pointed at the notes; skip the next run's notice.
			const config = yield* MapleConfig
			yield* config.write({ lastSeenVersion: stripV(result.tag) }).pipe(Effect.ignore)
		}),
	),
)
