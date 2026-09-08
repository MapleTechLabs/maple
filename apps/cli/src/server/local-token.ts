import { randomBytes, timingSafeEqual } from "node:crypto"
import { lstatSync, readFileSync } from "node:fs"
import { Result, Schema } from "effect"
import { durableWrite } from "./durable-files"

export const readRealFile = (path: string, label: string): string => {
	const stat = lstatSync(path)
	if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} is not a real file: ${path}`)
	return readFileSync(path, "utf8")
}

export const ensureLocalToken = async (path: string, label: string): Promise<string> => {
	const existing = Result.try(() => readRealFile(path, label))
	if (Result.isFailure(existing)) {
		const missing = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }))(existing.failure)
		if (!missing) throw existing.failure
		await durableWrite(path, `${randomBytes(32).toString("hex")}\n`)
	}
	const token = readRealFile(path, label).trim()
	return Schema.decodeUnknownSync(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)))(token)
}

export const localTokenMatches = (expected: string, supplied: string | null): boolean => {
	if (supplied === null) return false
	const left = Buffer.from(expected)
	const right = Buffer.from(supplied)
	return left.length === right.length && timingSafeEqual(left, right)
}
