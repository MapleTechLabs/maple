// Stub for the `cloudflare:workers` virtual module so worker-dependent code can
// be imported in the node test environment (vitest). Only the symbols that
// `@maple/effect-cloudflare`'s barrel statically imports are needed here
// (`DurableObject`, `WorkflowEntrypoint`); runtime worker behavior is never
// exercised in unit tests — services that read bindings are stubbed via layers.
export class DurableObject {}
export class WorkflowEntrypoint {}
