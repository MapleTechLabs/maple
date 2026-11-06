# External projectors in Maple Local

`maple start --projector-module /path/to/projectors.mjs` loads explicitly selected local code
into Maple Local's eventing registry. Repeat the flag to load multiple modules. This works in
both source runs and the compiled binary, including `--background` starts.

Modules supply `SignalProjector` implementations. Projection specifications, OTLP normalization,
CloudEvent identity, durable outbox state, and the [consumer protocol](local-event-consumers.md)
remain owned by Maple. Loading a module does not activate any projection; activate a specification
through `POST /local/eventing/projections` using the maintenance credential.

## Module contract

Export a default object with `apiVersion: 1` and a `register` function. Maple passes a registration
callback; call it once for each projector. The callback accepts the existing `SignalProjector`
interface. Registration may return a promise, which Maple awaits before opening chDB or listening.
All calls to the callback must finish before registration returns or its promise resolves; retained
callbacks cannot register projectors later.

For example, a TypeScript module in this workspace can use the type-only contract:

```ts
import type { ProjectorModule } from "@maple/eventing-core"

export default {
	apiVersion: 1,
	register(registerProjector) {
		registerProjector({
			id: "example.record.observed",
			version: 1,
			sourceKinds: ["otel.log"],
			outputType: "dev.maple.example.record.observed.v1",
			dataSchema: "urn:example:record-observed:v1",
			decodeConfig: () => ({}),
			decodeOutput: () => ({ observed: true }),
			project: (signal) => ({
				subject: signal.occurrenceId ?? undefined,
				data: { observed: true },
			}),
		})
	},
} satisfies ProjectorModule
```

Bundle the module and its runtime dependencies as an ESM `.mjs` file:

```sh
bun build ./projectors.ts --target=bun --format=esm --outfile ./projectors.mjs
maple start --offline --projector-module ./projectors.mjs
```

The core package is a workspace package; external authors can also write plain JavaScript against
the same structural contract. Type-only imports disappear from the bundle. Do not leave workspace
runtime imports unresolved and expect the compiled Maple binary to expose its internal packages.
Implement real configuration and output decoders for your projector's schema; the example above
only emits a fixed boolean payload. Projectors must keep projection deterministic and avoid I/O.

## Startup and restart behavior

Paths are resolved relative to the starting process's working directory and canonicalized before
being forwarded to a background process. Both the selected path and its resolved target must have
an `.mjs` extension and name a regular file. Package names and URLs are not supported.

The serving process loads and validates modules while holding the exclusive PID claim, before
checkpoint reconciliation, migration abandonment, explicit reset, or dirty-store recovery. A
background parent hands the claim and reset option to its child without changing the store; the
child loads modules once and reuses that registry when starting the server. Invalid modules thus
leave the existing live store intact even with `--reset` or `--on-dirty-store=wipe`.

Each start builds a fresh registry, loads modules in flag order, and compiles saved projections
against that registry. Invalid exports, unsupported API versions, invalid projector registrations,
duplicate module paths, or duplicate projector ID/version pairs fail startup. A registration error
fails startup even when the module ignores it. Import and registration failures identify the module
path. Existing starts without modules continue to use an empty external projector registry.

Supply all required modules on every restart. Module paths and executable code are not saved in the
control store or checkpoints. Restoring a checkpoint on another host requires deploying the matching
modules there too. A saved projection referencing a missing projector fails startup rather than
silently dropping that projection. Keep old projector versions available until their saved
specifications have been replaced. Module `apiVersion` versions this loading contract; a projector's
own `version` identifies its event interpretation and participates in projection identity.

Modules run trusted code with the server's privileges. This is not a sandbox, package installer,
remote-code loader, or hot-reload mechanism. Module initialization can perform arbitrary work and
has no execution time limit. Deploy only reviewed modules and restart Maple to change them.
