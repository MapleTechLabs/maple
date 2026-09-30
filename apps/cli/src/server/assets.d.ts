// Bun embeds text-typed imports (`import s from "./x.sql" with { type: "text" }`)
// into the `--compile`d binary and resolves them from disk in dev. These ambient
// declarations give those imports a `string` type.
declare module "*.sql" {
	const content: string
	export default content
}
declare module "*.proto" {
	const content: string
	export default content
}
// `with { type: "file" }` imports are embedded the same way and resolve to a
// path readable with `node:fs`.
declare module "*.wasm" {
	const path: string
	export default path
}
