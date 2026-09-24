import { Effect, Result, Schema, Stream } from "effect"
import { ClickHouseLimitError, ClickHouseProtocolError, ClickHouseServerError, serverError } from "./errors"

export interface Limits {
	/** Total decompressed response bytes, including whitespace and exception frames. */
	readonly maxBytes?: number
	readonly maxRows?: number
	/** Maximum bytes in an individual unfinished row. Default: 16 MiB. */
	readonly maxRowBytes?: number
}
export interface ResponseInfo {
	readonly status: number
	readonly queryId: string
	readonly exceptionTag?: string
}
export type ProtocolFailure = ClickHouseLimitError | ClickHouseProtocolError | ClickHouseServerError
const ERROR_BYTES = 16 * 1024
const encoder = new TextEncoder()
const isRow = Schema.is(Schema.Record(Schema.String, Schema.Unknown))

/** Synchronous framing state with typed Result failures; the stream lifts them into Effect. */
class Decoder {
	private buffer: Uint8Array = new Uint8Array(0)
	private length = 0
	private bytes = 0
	private rows = 0
	private invalid = ""
	private invalidBytes = 0
	private readonly utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
	constructor(
		private readonly info: ResponseInfo,
		private readonly limits: Limits,
	) {}

	private protocol(message: string): Result.Result<never, ClickHouseProtocolError> {
		return Result.fail(
			new ClickHouseProtocolError({
				...this.info,
				message: `Failed to parse ClickHouse response: ${message}`,
			}),
		)
	}
	private limit(
		kind: "bytes" | "rows" | "rowBytes",
		limit: number,
	): Result.Result<never, ClickHouseLimitError> {
		return Result.fail(
			new ClickHouseLimitError({
				...this.info,
				kind,
				limit,
				message: `ClickHouse response exceeded ${kind} limit (${limit})`,
			}),
		)
	}
	private decode(bytes: Uint8Array): Result.Result<string, ClickHouseProtocolError> {
		const decoded = Result.try(() => this.utf8.decode(bytes))
		if (Result.isFailure(decoded)) return this.protocol("invalid UTF-8")
		return Result.succeed(decoded.success)
	}
	private append(bytes: Uint8Array): Result.Result<void, ProtocolFailure> {
		const max = this.invalidBytes > 0 ? ERROR_BYTES : (this.limits.maxRowBytes ?? 16 * 1024 * 1024)
		if (this.length + bytes.length > max) {
			if (this.invalidBytes > 0) return this.protocol("exception payload exceeds 16 KiB")
			return this.limit("rowBytes", max)
		}
		if (this.length + bytes.length > this.buffer.length) {
			const capacity = Math.min(max, Math.max(this.length + bytes.length, this.buffer.length * 2, 1024))
			const next = new Uint8Array(capacity)
			next.set(this.buffer.subarray(0, this.length))
			this.buffer = next
		}
		this.buffer.set(bytes, this.length)
		this.length += bytes.length
		return Result.succeed(undefined)
	}
	private takeLine(): Result.Result<string, ClickHouseProtocolError> {
		const text = this.decode(this.buffer.subarray(0, this.length))
		this.length = 0
		return text
	}
	private line(
		text: string,
		out: Record<string, unknown>[],
		ended = true,
	): Result.Result<void, ProtocolFailure> {
		if (this.invalidBytes > 0) {
			return this.addInvalid(text, ended)
		}
		if (text.trim() === "") return Result.succeed(undefined)
		// BOUNDARY: JSON.parse returns untrusted wire data, validated as an object row below.
		const parsed = Result.try((): unknown => JSON.parse(text))
		if (Result.isFailure(parsed)) {
			return this.addInvalid(text, ended)
		}
		const value = parsed.success
		if (!isRow(value)) return this.protocol("expected a JSON object row")
		this.rows++
		if (this.limits.maxRows !== undefined && this.rows > this.limits.maxRows)
			return this.limit("rows", this.limits.maxRows)
		out.push(value)
		return Result.succeed(undefined)
	}
	private addInvalid(text: string, ended: boolean): Result.Result<void, ClickHouseProtocolError> {
		const size = encoder.encode(text).length + (ended ? 1 : 0)
		if (this.invalidBytes === 0 && size > ERROR_BYTES) {
			// Discard a large incomplete JSON row, but still allow a following
			// bounded exception frame to identify the actual server failure.
			this.invalidBytes = 1
			return Result.succeed(undefined)
		}
		this.invalidBytes += size
		if (this.invalidBytes > ERROR_BYTES)
			return this.protocol("malformed row or exception payload exceeds 16 KiB")
		this.invalid += text + (ended ? "\n" : "")
		return Result.succeed(undefined)
	}
	push(chunk: Uint8Array): Result.Result<Record<string, unknown>[], ProtocolFailure> {
		return Result.gen(this, function* () {
			this.bytes += chunk.length
			if (this.limits.maxBytes !== undefined && this.bytes > this.limits.maxBytes)
				return yield* this.limit("bytes", this.limits.maxBytes)
			const out: Record<string, unknown>[] = []
			let start = 0
			for (let i = 0; i < chunk.length; i++) {
				if (chunk[i] !== 10) continue
				yield* this.append(chunk.subarray(start, i))
				yield* this.line(yield* this.takeLine(), out)
				start = i + 1
			}
			yield* this.append(chunk.subarray(start))
			// ClickHouse may close chunked HTTP without a terminal HTTP chunk after
			// writing an exception. Recognize a complete exception before awaiting EOF,
			// otherwise the ensuing transport failure would hide the server error.
			if (
				this.invalid.endsWith("\r\n__exception__\r\n") &&
				this.invalid.indexOf("__exception__\r\n") !== this.invalid.lastIndexOf("__exception__\r\n")
			)
				return yield* this.finish()
			if (
				this.invalidBytes > 0 &&
				!this.invalid.includes("__exception__") &&
				/\b(?:Code|Error):\s*\d+[^\n]*Exception:[\s\S]*\([A-Z][A-Z0-9_]{2,}\)[^\n]*\n$/.test(
					this.invalid,
				)
			)
				return yield* this.finish()
			return out
		})
	}
	finish(): Result.Result<Record<string, unknown>[], ProtocolFailure> {
		return Result.gen(this, function* () {
			const out: Record<string, unknown>[] = []
			if (this.length > 0) yield* this.line(yield* this.takeLine(), out, false)
			if (this.invalidBytes === 0) return out
			const text = this.invalid
			const marker = text.indexOf("__exception__\r\n")
			if (marker >= 0) {
				// A server exception may follow an unfinished JSON row. Validate the frame,
				// its echoed header tag, and its UTF-8 byte length before extracting it.
				const frame = text.slice(marker)
				const lines = frame.split("\r\n")
				const tag = lines[1]
				if (!tag || !/^[A-Za-z0-9_-]{1,128}$/.test(tag) || tag !== this.info.exceptionTag)
					return yield* this.protocol("invalid exception tag")
				if (!frame.endsWith("\r\n__exception__\r\n"))
					return yield* this.protocol("truncated exception frame")
				const footerEnd = frame.length - "\r\n__exception__\r\n".length
				const footerStart = frame.lastIndexOf("\n", footerEnd - 1) + 1
				const footer = frame.slice(footerStart, footerEnd)
				const match = /^(\d+) ([A-Za-z0-9_-]+)$/.exec(footer)
				if (!match || match[2] !== tag) return yield* this.protocol("invalid exception footer")
				const message = frame.slice("__exception__\r\n".length + tag.length + 2, footerStart)
				if (encoder.encode(message).length !== Number(match[1]))
					return yield* this.protocol("invalid exception byte length")
				return yield* Result.fail(serverError(message, this.info.status, this.info.queryId))
			}
			if (/\b(?:Code|Error):\s*\d+[^\n]*Exception:/.test(text))
				return yield* Result.fail(serverError(text, this.info.status, this.info.queryId))
			return yield* this.protocol("malformed or truncated JSONEachRow")
		})
	}
}

export const decodeRows = <E, R>(
	source: Stream.Stream<Uint8Array, E, R>,
	info: ResponseInfo,
	limits: Limits,
) =>
	Stream.unwrap(
		Effect.sync(() => {
			const decoder = new Decoder(info, limits)
			return source.pipe(
				Stream.mapEffect((chunk) => Effect.suspend(() => Effect.fromResult(decoder.push(chunk)))),
				Stream.concat(Stream.fromEffect(Effect.suspend(() => Effect.fromResult(decoder.finish())))),
				Stream.flattenIterable,
			)
		}),
	)
