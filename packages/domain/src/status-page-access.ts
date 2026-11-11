import { Effect, Option, Result, Array as Arr, String as Str } from "effect"
import { Base64Url } from "effect/encoding"
import { codeUnitAt } from "@maple/strings"

// Password-protected status pages: the API stores a slow hash of the password, the publisher
// puts that hash in the page's edge snapshot (never in anything rendered), and the status Worker
// checks a posted password against it and signs the visitor's access cookie with it. A new
// password is a new salt, so every cookie signed under the old one stops verifying.

export const STATUS_PAGE_PASSWORD_MIN_LENGTH = 8
/** Bounds the work one posted password costs. */
export const STATUS_PAGE_PASSWORD_MAX_LENGTH = 256

/** Workers' WebCrypto refuses PBKDF2 above 100,000 iterations. */
const PBKDF2_ITERATIONS = 100_000
const HASH_SCHEME = "pbkdf2-sha256"
const KEY_BYTES = 32
const SALT_BYTES = 16

/** The access cookie: one per page path, so two pages on Maple's shared host never share one. */
export const STATUS_PAGE_ACCESS_COOKIE = "maple_status_access"
export const STATUS_PAGE_ACCESS_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

const encoder = new TextEncoder()

/** Compares every character whatever the first mismatch, so timing does not leak the value. */
export const constantTimeEqual = (a: string, b: string): boolean =>
	Arr.reduce(
		Array.from(
			{ length: Math.max(a.length, b.length) },
			(_, index) => codeUnitAt(a, index) ^ codeUnitAt(b, index),
		),
		a.length ^ b.length,
		(diff, bits) => diff | bits,
	) === 0

const derive = (password: string, salt: Uint8Array<ArrayBuffer>, iterations: number) =>
	Effect.promise(async () => {
		const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
			"deriveBits",
		])
		const bits = await crypto.subtle.deriveBits(
			{ name: "PBKDF2", hash: "SHA-256", salt, iterations },
			key,
			KEY_BYTES * 8,
		)
		return Base64Url.encode(new Uint8Array(bits))
	})

/** `pbkdf2-sha256$<iterations>$<salt>$<key>`, base64url: what `status_pages.password_hash` holds. */
export const hashStatusPagePassword = (password: string): Effect.Effect<string> =>
	Effect.suspend(() => {
		const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
		return derive(password, salt, PBKDF2_ITERATIONS).pipe(
			Effect.map((key) => `${HASH_SCHEME}$${PBKDF2_ITERATIONS}$${Base64Url.encode(salt)}$${key}`),
		)
	})

interface StoredHash {
	readonly iterations: number
	readonly salt: Uint8Array<ArrayBuffer>
	readonly key: string
}

const parseStoredHash = (stored: string): Option.Option<StoredHash> => {
	const [scheme, rawIterations, rawSalt, key, ...rest] = Str.split("$")(stored)
	if (scheme !== HASH_SCHEME || rest.length > 0 || rawSalt === undefined || key === undefined)
		return Option.none()
	if (!/^[0-9]{1,6}$/u.test(rawIterations ?? "")) return Option.none()
	const iterations = Number(rawIterations)
	if (iterations < 1 || iterations > PBKDF2_ITERATIONS) return Option.none()
	return Option.map(Result.getSuccess(Base64Url.decode(rawSalt)), (salt) => ({
		iterations,
		salt: new Uint8Array(salt),
		key,
	}))
}

/** Whether `password` matches the stored hash; a hash this code cannot read matches nothing. */
export const verifyStatusPagePassword = (password: string, stored: string): Effect.Effect<boolean> =>
	Option.match(parseStoredHash(stored), {
		onNone: () => Effect.succeed(false),
		onSome: (parsed) =>
			password.length > STATUS_PAGE_PASSWORD_MAX_LENGTH
				? Effect.succeed(false)
				: derive(password, parsed.salt, parsed.iterations).pipe(
						Effect.map((key) => constantTimeEqual(key, parsed.key)),
					),
	})

/** HMAC-SHA256 keyed by the stored hash, which only the API and the edge hold. */
const accessSignature = (stored: string, pageId: string, expiresAtMs: number) =>
	Effect.promise(async () => {
		const key = await crypto.subtle.importKey(
			"raw",
			encoder.encode(stored),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		)
		const signature = await crypto.subtle.sign(
			"HMAC",
			key,
			encoder.encode(`maple/status-page/access/v1|${pageId}|${expiresAtMs}`),
		)
		return Base64Url.encode(new Uint8Array(signature))
	})

/** The access cookie's value: `<expires at, epoch ms>.<signature>`, bound to the page and its password. */
export const signStatusPageAccess = (
	stored: string,
	pageId: string,
	expiresAtMs: number,
): Effect.Effect<string> =>
	accessSignature(stored, pageId, expiresAtMs).pipe(Effect.map((signature) => `${expiresAtMs}.${signature}`))

/**
 * Whether a cookie value grants access to the page now: signed with its current password hash,
 * not expired, and not issued for longer than a cookie lives.
 */
export const verifyStatusPageAccess = (
	stored: string,
	pageId: string,
	value: string,
	nowMs: number,
): Effect.Effect<boolean> => {
	const match = /^([0-9]{1,15})\.([A-Za-z0-9_-]{1,64})$/u.exec(value)
	const expiresAtMs = Number(match?.[1] ?? "0")
	const signature = match?.[2]
	if (
		signature === undefined ||
		expiresAtMs <= nowMs ||
		expiresAtMs > nowMs + STATUS_PAGE_ACCESS_MAX_AGE_SECONDS * 1000
	)
		return Effect.succeed(false)
	return accessSignature(stored, pageId, expiresAtMs).pipe(
		Effect.map((expected) => constantTimeEqual(signature, expected)),
	)
}
