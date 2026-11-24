/**
 * The self-hosted root password rules, as a leaf: `Env` validates the password at boot and must not
 * load this package's Clerk client and HTTP schemas to do it.
 */
import { String as Str } from "effect"

/** Shortest root password a self-hosted deployment accepts. */
export const MIN_ROOT_PASSWORD_LENGTH = 16
const PLACEHOLDER_ROOT_PASSWORDS: ReadonlySet<string> = new Set([
	"change-me",
	"changeme",
	"change-me-please",
	"password",
	"placeholder",
	"maple",
	"admin",
	"root",
])

/** Why a root password is too weak to start with, or undefined when it is acceptable. */
export const rootPasswordProblem = (password: string): string | undefined => {
	const trimmed = Str.trim(password)
	if (trimmed.length === 0) return "MAPLE_ROOT_PASSWORD cannot be empty"
	if (PLACEHOLDER_ROOT_PASSWORDS.has(Str.toLowerCase(trimmed))) {
		return "MAPLE_ROOT_PASSWORD is a placeholder value; generate one with `openssl rand -base64 24`"
	}
	if (password.length < MIN_ROOT_PASSWORD_LENGTH) {
		return `MAPLE_ROOT_PASSWORD must be at least ${MIN_ROOT_PASSWORD_LENGTH} characters; generate one with \`openssl rand -base64 24\``
	}
	return undefined
}
