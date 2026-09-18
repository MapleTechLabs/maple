# `@maple/eventing-core`

Signal-to-event contracts and deterministic runtime semantics.

Canonical hashing uses `node:crypto` and `Buffer`. Supported hosts are Node.js,
Bun, and Cloudflare Workers with `nodejs_compat` enabled.

The package owns typed signal values, bounded selectors, pure projector
registration, canonical event identity, and an immutable compiled projection
registry. It has no database, network, scheduler, or wall-clock dependency. A
host authenticates and normalizes source input, supplies durable projection and
outbox adapters, and decides when compiled registries become active.

See [`docs/signal-to-event-projection.md`](../../docs/signal-to-event-projection.md)
for the architecture and acceptance contract.

See [`docs/eventing-extension-guide.md`](../../docs/eventing-extension-guide.md)
for a complete source adapter and projector example, registration and host
wiring patterns, versioning rules, and the required test checklist. Eventing
extensions are compile-time registered modules, not dynamically loaded plugins.

The versioned interoperability artifacts are generated under `schemas/`, with
valid comparison and identity vectors in `fixtures/v1.json`. Run `bun run test` to
verify generated-schema drift, hostile selector bounds, typed comparison
semantics, deterministic event IDs, and projector isolation. Scalar conformance
checks run the published artifacts through a Draft 2020-12 JSON Schema validator,
including exact integer bounds and calendar validity. Schema consumers must also
perform the mandatory predicate depth/node preflight described in the generated
predicate definition; JSON Schema validation alone does not enforce those
whole-tree limits.

The first host adapter is Maple Local in `apps/cli/src/server/eventing`. It uses
an authenticated configuration endpoint, a SQLite projection/outbox store, and
the pre-chDB OTLP seam. The package itself deliberately contains none of those
host decisions.
