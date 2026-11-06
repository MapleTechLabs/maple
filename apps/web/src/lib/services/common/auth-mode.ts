import { Option, String as Str } from "effect"

const authMode = Option.map(Option.fromNullishOr(import.meta.env.VITE_MAPLE_AUTH_MODE), (mode) =>
	Str.toLowerCase(Str.trim(mode)),
).pipe(Option.getOrUndefined)

const mapleAuthMode = authMode === "clerk" ? "clerk" : "self_hosted"
export const isClerkAuthEnabled = mapleAuthMode === "clerk"
