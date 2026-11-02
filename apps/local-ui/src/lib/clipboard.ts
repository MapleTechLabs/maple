import { Effect, Schema } from "effect"

export class ClipboardWriteError extends Schema.TaggedError<ClipboardWriteError>()(
	"@maple/local-ui/ClipboardWriteError",
	{
		message: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/** A clipboard write; a refused permission or an unfocused document is a typed failure. */
export const writeClipboard = (text: string) =>
	Effect.tryPromise({
		try: () => navigator.clipboard.writeText(text),
		catch: (cause) => new ClipboardWriteError({ message: "Clipboard write failed", cause }),
	})
