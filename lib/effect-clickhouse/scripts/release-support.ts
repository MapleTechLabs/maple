import { Effect, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"

export class ReleaseCheckError extends Schema.TaggedError<ReleaseCheckError>()(
	"@maple-dev/effect-clickhouse/ReleaseCheckError",
	{ message: Schema.String, check: Schema.String },
) {}

export class CommandFailed extends Schema.TaggedError<CommandFailed>()(
	"@maple-dev/effect-clickhouse/CommandFailed",
	{
		message: Schema.String,
		command: Schema.String,
		args: Schema.Array(Schema.String),
		exitCode: Schema.Finite,
	},
) {}

export const check = (condition: boolean, name: string, message: string) =>
	condition ? Effect.void : Effect.fail(new ReleaseCheckError({ check: name, message }))

// Each child owns a scope: failure, timeout or interruption terminates it before
// callers remove temporary files. Drain captured stdout while waiting for exit.
export const runCommand = Effect.fn("release.runCommand")(function* (
	command: string,
	args: readonly string[],
	cwd: string,
	capture = false,
) {
	return yield* Effect.scoped(
		Effect.gen(function* () {
			const child = yield* ChildProcess.make(command, args, {
				cwd,
				stdin: "inherit",
				stdout: capture ? "pipe" : "inherit",
				stderr: "inherit",
			})
			const { exitCode, output } = yield* Effect.all(
				{
					exitCode: child.exitCode,
					output: capture
						? child.stdout.pipe(
								Stream.decodeText(),
								Stream.runFold(
									() => "",
									(text, chunk) => text + chunk,
								),
							)
						: Effect.succeed(""),
				},
				{ concurrency: "unbounded" },
			)
			if (exitCode !== 0)
				return yield* new CommandFailed({
					message: `${command} exited with code ${exitCode}`,
					command,
					args,
					exitCode,
				})
			return output
		}),
	).pipe(Effect.timeout("3 minutes"))
})
