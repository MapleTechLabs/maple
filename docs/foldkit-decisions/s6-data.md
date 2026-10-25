# S6: Data layer

Status: **decided** · 2026-10-17 · Branch `worktree-agent-a657c2439b7c27ded` (from `fk/parity-harness`)

Question: how do Maple's atoms, warehouse batcher, HTTP clients and Electric collections become
Foldkit Model, Commands and Subscriptions without changing a single request on the wire?

## Result

`/lab/data-probe` (`apps/web-foldkit/src/lab/data-probe/`) loads the services facets through the
batcher and counts alert rules through a liveQuery. Captured on the fixture backend (`default`,
`PARITY_PORT_BASE=5390 parity capture foldkit --filter data-probe --run s6-data-probe`): `ok`, 0 unmocked, 0 console errors, 0 blocked;
renders `Services: 6`, `Environments: 1`, `Alert rules: 4`. Call log: `auth.session`,
`shape:alert_rules`, `warehouse:d30b8a280cb4c1c9`. Legacy `/services` (legacy-head, same run
setup) sends the **same fingerprint** `d30b8a280cb4c1c9` (`facets/services`, 00:00 to 12:00):
the window resolution and key snap are byte-identical. Tests (vitest): batcher 5 (window, full
flush, stale timer, per-item outcomes, whole failure), keyed slots 5 (stale drop, dedupe, refresh,
keep-previous, keep-stale), liveQuery 2 (live updates, org re-keying releases the old live query),
probe Scene 4.

Bundle: the startup chunk grows by about 52 KB gzip for the query-engine barrel and batcher and
85 KB gzip for `@tanstack/db` + Electric when `OrgCollections` is a startup resource. React is
not bundled (react-db is `sideEffects: false`), but see "Outside scope".

## Design (`apps/web-foldkit/src/data/`)

| File                              | Role                                                                                                                                                                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execute-batcher.ts`              | Legacy `makeExecuteBatcher` as an Effect: `Ref` state, timer fibers forked in the resource scope, same 15 ms window (`EXECUTE_BATCH_WINDOW_MS` imported), cap 4, early flush, overflow into a fresh window, positional per-item outcomes |
| `warehouse.ts`                    | `WarehouseExecutor` resource over `MapleInternalApiClient.queryEngine.executeBatch`; one instance per runtime, so Commands on separate fibers share batches like atoms do                                                                |
| `request-key.ts`, `time-range.ts` | `encodeOrgScopedKey` and `resolveEffectiveTimeRange` + the 15 s key snap; the snapped window is what is sent (legacy decodes its key back into the request)                                                                              |
| `keyed.ts`                        | `Keyed<A, E>` = `{ key, data: AsyncData }`; `request(slot, key, "Load" \| "Refresh")` and `accept(slot, key, result)`                                                                                                                    |
| `live-query.ts`                   | Hazel's `liveQueryStream` over TanStack DB `createLiveQueryCollection`                                                                                                                                                                   |
| `collections/`                    | `OrgCollections` resource: one set per org (`<shape>:<org>` ids, `org=` param, bearer `fetchClient`), superseded set cleaned up when its live queries drain                                                                              |
| `warehouse-error.ts`              | `WarehouseQueryError` (tagged, in the Effect channel) and `WarehouseFailure` (plain data for Messages)                                                                                                                                   |

Rules: a fetch Command carries its request key in its result Message; `update` drops a result
whose key is not the slot's current key (`Keyed.accept`). A liveQuery Message carries the org it
was read for; `update` drops other orgs. Commands are not interruptible: the query is already in
its batch and the warehouse runs it anyway.

## Reuse by import

| Legacy                                                                                                 | Importable?                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api/warehouse/execute-batcher.ts`                                                                     | Yes (only `@maple/query-engine`); constants imported, logic re-expressed in Effect                                                                                                    |
| `api/warehouse/effect-utils.ts` and the 29 query modules on it or on the atom clients (30 of 33 files) | **No**: `effect-utils` imports `lib/registry` (atom registry, React, OTel layer, runs `mapleRuntime` at load) and `internal-atom-client` (`AtomHttpApi` from `effect-atom.ts`, React) |
| `timeseries-utils.ts`, `service-external-edges.ts`                                                     | React-free, but `@/` imports break foldkit's typecheck (TS `paths` are global: `@/` means foldkit's `src`)                                                                            |
| `lib/cache-key.ts`, `lib/time-utils.ts`                                                                | No: `time-utils` imports timezone atoms. Logic copied into `request-key.ts`, `time-range.ts`                                                                                          |
| `lib/collections/alerts.ts` row schemas                                                                | No: same module as factories that use `shape-fetch.ts` (registry). `AlertRuleRowSchema` copied, diffed equal                                                                          |
| `lib/collections/org-collections.ts`                                                                   | No (`useSyncExternalStore`, module state)                                                                                                                                             |
| `@maple/effect-db/electric`, `electric-sync-url.ts`                                                    | Yes                                                                                                                                                                                   |

Phase 1 extraction (outside this spike's scope, see "Outside scope"): split `effect-utils.ts`
into a framework-free core whose query functions require two services, `WarehouseExecutor`
(execute one request) and an internal-client tag typed `HttpApiClient.ForApi<MapleInternalApi>`
(not `AtomHttpApi.Service`). apps/web provides them from its registry, Foldkit from its
resources, and both import the same `api/warehouse/*` functions. Same for collections: row
schemas and `rowTo*` mappers in their own module, `createSyncedCollection` taking runtime and
`fetchClient` as arguments.

## Refresh and cache policy

**Decision: Model-held per page, dropped on navigation (Hazel); data that legacy shares across
routes lives in root Model slots; no keyed cache resource.** From the legacy code: every
warehouse family's `staleTime` is an idle TTL, "NOT a freshness window" (`warehouse-query-atoms.ts`):
a mounted atom never refetches on it, it only makes a quick back-navigation free. Relative presets
re-key on every snap grid step (15 s to 30 min, `snapRangeForCache`), so revisits mostly miss the
TTL anyway, which is why `withRetention` (LRU 400, 30 min) and `useRetainedResult` exist: they
serve the previous success as `waiting` while the real fetch runs and never suppress a request.
Their value is "no skeleton flash", which `Keyed.request` gives inside a page (`Refreshing` with
the previous data on a key change, `Loading` on an org change, as `useRetainedResult` does).
Lost: data surviving a navigation away and back. Superseded for that case by "Read cache" below.

## Read cache

Status: **decided** · 2026-10-18. Parity showed the loss above: a page reading what the previous
page read (releases then services commit lookups, a trace chip then the trace) sent it twice.

- `ReadCache` (`data/read-cache.ts`) is one resource: entries by `RequestKey` (org + operation +
  input, the atom key), each a `Deferred` of the answer. A reader joins an in-flight entry, reuses a
  live one, or loads (forked in the cache's scope). Failures reach their readers and are dropped.
- TTL is legacy's idle TTL per family (`data/idle-ttl.ts`), counted from the entry's last read or
  release. The root holds a page instance's keys (`Preload.held`, the `args.key` of every Command
  it sends) and releases them in `ReleaseReads` when the instance changes, as an unmount starts an
  atom's idle TTL. A preload's keys are released when its 30 s hold ends.
- A cached value must pass the reader's schema (`Schema.is`), so two readers sharing a key never
  trade wrong shapes; a mismatch loads again. LRU bound 400 (`withRetention`).
- Org: `ReleaseReads` names the new instance's org and `scopeTo` drops other orgs' entries; reads
  for another org's key also drop them. `readInOrg` keys a read under the open org for readers
  without one (the shell's namespace list, the chat's known services).
- Rules: a cached read's Command carries `key` (so it is held and released) and keys cross-page
  reads through one builder (`commitDetailKey`, `spanHierarchyKey`); a `"Refresh"` with an
  unchanged key passes `refresh`. Window-keyed reads re-key on refresh (unsnapped window).
- Preload is the same mechanism: a `preload`'s Commands read through the cache and their result
  Messages are dropped; the opening page's own reads join or reuse them. Every `preload` Command
  must be a cached read. `update` stays pure: the clock is read inside the cache's Effects.
- Hand-offs are the same mechanism too: the traces peek runs the trace page's own cached reads,
  so Open trace joins them, even mid-flight (no `HandedOff` out-message).
- Not cached: reads no other page or revisit shares. Move a family on when parity shows a repeat.

Refresh (`useAtomRefresh` 108 calls, `useRefreshableAtomValue` 103): one explicit page Message
(`ClickedRefresh`) re-resolves the window unsnapped (legacy's `refreshVersion`) and applies
`Keyed.request(slot, key, "Refresh")` to every slot; a per-panel retry is the same for one slot.
Mutation invalidation (`reactivityKeys`, 195) is the mutation's result handler revalidating the
affected slots (`AsyncData.revalidate` semantics: loaded slots only). Auto-refresh is a
Subscription gated on the Model that dispatches the same Message.

## Atom mapping guide (Phase 3)

Census of `apps/web/src` (non-test): `useAtomValue` 281, `Result.builder` 311, `useAtomRefresh`
108, `useAtomSet` 105, `useRefreshableAtomValue` 103.

| Legacy pattern (count)                                                        | Foldkit                                                                                                                                                           |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Warehouse family `makeQueryAtomFamily` (126 families) read via `useAtomValue` | `Keyed` slot + fetch Command over `WarehouseExecutor` (the probe's `FetchServicesFacets`)                                                                         |
| HTTP query `retainedQuery`/`V2`/`Internal` (134), bare `.query` (7)           | `Keyed` slot keyed by `requestKey(org, "group.endpoint", request)` + Command on the S1 client resource                                                            |
| Mutation `.mutation` (115) + `useAtomSet`                                     | Message, Command, `Succeeded*`/`Failed*`; revalidate slots instead of `reactivityKeys`                                                                            |
| Writable UI state `Atom.make(value)` (29), `useAtom` (24)                     | Model field + Message                                                                                                                                             |
| Persisted `Atom.kvs` (14)                                                     | Model field; Flags read storage before init; a `Save*` Command writes                                                                                             |
| Non-query `Atom.family` (18, per-org prefs)                                   | Field for the live key, or `Schema.HashMap` keyed by id                                                                                                           |
| Derived `Atom.make((get) => ...)` (5), `Atom.map` (1), `Result.all`           | Plain function of the Model in `view`; `AsyncData.all`                                                                                                            |
| Route preload `warmAtoms` (14 in 8 routes); `routeAtom` (0)                   | Route-entry handler returns the fetch Commands (`"Load"`)                                                                                                         |
| `useLiveQuery` (8 in 5 files)                                                 | Subscription, deps `{ orgId, ...inputs }`, rows Message carries `orgId`                                                                                           |
| Org / time range / global namespace read in key builders                      | Root Model fields passed to the page's `load(model, scope)`; part of every key and request (pin the namespace with the `applyGlobalNamespace` rule before keying) |
| `Result.builder(...)` (311)                                                   | `AsyncData.match` / `matchData`; `Refreshing` is legacy's `waiting`                                                                                               |
| `ScopedAtom` (4 files)                                                        | Submodel state                                                                                                                                                    |

```ts
// Query: `useAtomValue(getServicesFacetsResultAtom({ data: window }))`
const key = requestKey(orgId, "getServicesFacets", { data: window })
Option.match(Keyed.request(model.facets, key, mode), {
	onNone: () => ({ model }),
	onSome: (facets) => ({ model: { ...model, facets }, commands: [FetchServicesFacets({ key, window })] }),
})
// Result: CompletedFetchServicesFacets({ key, result }) => Keyed.accept(model.facets, key, result)

// Mutation with reactivityKeys: ClickedSave -> SaveRule Command -> SucceededSaveRule, whose
// handler runs the branch above with mode "Refresh" for each slot the keys used to invalidate.

// useLiveQuery((q) => q.from({ rule: alertRules })) as a Subscription entry:
entry(
	{ orgId: Schema.NullOr(OrgId) },
	{
		modelToDependencies: (model) => ({ orgId: model.orgId }),
		dependenciesToStream: ({ orgId }) => (orgId === null ? Stream.empty : alertRuleCounts(orgId)),
	},
)
```

## Gotchas

| Gotcha                                                                                        | Consequence                                                                                                   |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Legacy decodes the snapped atom key back into the request                                     | Snap the window (`time-range.ts`) before keying and sending, or payloads differ                               |
| Scene refuses any interaction or `Subscription.emit` while a Command is unresolved            | Race tests (late answer after a newer key) go through `update` directly                                       |
| Foldkit interrupt never cancels on re-dispatch; it needs an explicit `Interrupt` Command      | Not worth it for warehouse reads; the receipt-time key check is the guard                                     |
| `createEffectCollection` requires a `ManagedRuntime`                                          | `OrgCollections` owns a scoped `ManagedRuntime.make(Layer.empty)`                                             |
| Direct query-engine endpoints (`serviceOverview`, `serviceHealthBaseline`) bypass the batcher | Port them as plain client Commands; the fixture does not serve them yet (legacy `/services` shows 2 unmocked) |

## Outside scope (needed)

- Phase 1 extraction above (`effect-utils`, atom clients, `cache-key`, collection row modules).
- `lib/effect-db/src/electric/collection.ts`: import `createCollection` from `@tanstack/db`, not
  `@tanstack/react-db`, so the package stops depending on React.
- foldkit `tsconfig` `@/*` could list `../web/src/*` as a fallback so React-free legacy modules
  with `@/` imports typecheck; needs a rule against shadowing.
- Not done: collection sync-failed and schema-heal handling (`collection:sync-failed` event as a
  Subscription), Clerk-mode org source for lab entries, legacy span names on Commands.
