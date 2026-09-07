// Stub for the `cloudflare:workers` virtual module so it can be imported in the
// node/vitest environment. The real module always exports `env`, and
// `WorkerEnvironment` destructures it. Omitting it made the service yield
// `undefined` rather than an empty binding record, so the first consumer to
// read a binding off it (rather than layering one in) crashed with "Cannot
// read properties of undefined".
//
// No `DurableObject` or `WorkflowEntrypoint` here: the api's hosted classes are
// plain classes the alchemy bridge stubs drive (`src/hosted-classes.ts`), and
// `test/chat/fake-do-state.ts` hands `ChatSession` a real SQLite-backed state.

/** No bindings in node/vitest — tests layer in whatever they need. */
export const env: Record<string, unknown> = {}
