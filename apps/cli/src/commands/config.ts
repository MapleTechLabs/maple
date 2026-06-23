import * as Command from "effect/unstable/cli/Command"
import * as Argument from "effect/unstable/cli/Argument"
import { Console, Effect } from "effect"
import { MapleConfig } from "../core/config"

/**
 * `maple use <local|remote|auto>` — pin the default backend (persisted in
 * `~/.maple/config.json`), so commands stop auto-detecting. `auto` clears the
 * pin and restores auto-detect (stored token → remote, else probe local).
 */
export const use = Command.make("use", {
	mode: Argument.choice("mode", ["local", "remote", "auto"]).pipe(
		Argument.withDescription("Backend to pin: local, remote, or auto (clear the pin)"),
	),
}).pipe(
	Command.withDescription("Pin the default mode (local/remote) or restore auto-detect"),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const config = yield* MapleConfig
			if (a.mode === "auto") {
				yield* config.clearDefaultMode()
				yield* Console.log(
					"Default mode cleared — Maple will auto-detect (use --local/--remote to override).",
				)
				return
			}
			yield* config.setDefaultMode(a.mode)
			yield* Console.log(`Default mode set to ${a.mode}. Override per-command with --local / --remote.`)
		}),
	),
)
