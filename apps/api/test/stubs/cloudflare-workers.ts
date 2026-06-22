// Stub for the `cloudflare:workers` virtual module so it can be imported in the
// node/vitest environment. Only `DurableObject` and `WorkflowEntrypoint` are
// needed — the modules in `@maple/effect-cloudflare` that statically import
// them are never exercised at runtime in unit tests (bindings are layered in).
export class DurableObject {}
export class WorkflowEntrypoint {}
