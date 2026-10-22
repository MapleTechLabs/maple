import { IntegrationsPersistenceError } from "@maple/domain/http"
import { Effect } from "effect"

/**
 * The text that is copied: the script as a here-document for a child bash. Pasted at a prompt,
 * nothing runs before the closing brace is read, a failing step ends the child and not the login
 * shell, and the terminal stays the script's stdin. The first line keeps the paste, secret and
 * all, out of the history file of zsh 5.3+ (which writes it after the command ran) and drops it
 * from the history of bash 5; its leading space does the same under `HISTCONTROL=ignorespace`
 * and `HIST_IGNORE_SPACE`. bash 3.2 keeps only the first line, which has no secret. Nothing
 * outside the here-document may be a comment: an interactive zsh runs `#` as a command.
 */
// A terminal, not the bytes, decides where a pasted line ends: a CR or a TAB (completion) in a
// value could end the here-document early and hand the rest to the login shell.
const PASTE_SAFE = /^[\x20-\x7e\n]*$/u

export const forPaste = (
	provider: string,
	marker: string,
	body: string,
): Effect.Effect<string, IntegrationsPersistenceError> =>
	!PASTE_SAFE.test(body) || body.split("\n").includes(marker)
		? Effect.fail(
				new IntegrationsPersistenceError({
					message: `A ${provider} script value would end the script's here-document early`,
				}),
			)
		: Effect.succeed(
				` { [ -z "\${ZSH_VERSION-}" ] || case "\${HISTORY_IGNORE-}" in *"*${marker}*"*) ;; *) HISTORY_IGNORE="(\${HISTORY_IGNORE:+$HISTORY_IGNORE|}*${marker}*)" ;; esac; [ -z "\${BASH_VERSION-}" ] || case "$(history 1)" in *${marker}*) history -d -1 ;; esac 2>/dev/null
bash /dev/fd/3 3<<'${marker}'
${body}${marker}
}
`,
			)
