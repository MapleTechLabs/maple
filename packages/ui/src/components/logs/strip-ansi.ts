// oxlint-disable-next-line no-control-regex
const ANSI_SGR = /\x1b\[[0-9;]*[A-Za-z]/g

/** Drops ANSI escape sequences (terminal colors) from a log body. Display only: copy and raw views keep the original. */
export function stripAnsi(text: string): string {
	return text.includes("\x1b") ? text.replace(ANSI_SGR, "") : text
}
