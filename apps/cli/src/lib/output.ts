import { Console } from "effect"

/**
 * Default output is pretty-printed JSON — readable for humans and trivially
 * parseable by agents/scripts piping the CLI.
 */
export const printJson = (data: unknown) => Console.log(JSON.stringify(data, null, 2))
