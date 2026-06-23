# Effect Todo — traced into Maple local mode

A tiny end-to-end demo of Maple's value: a real browser action produces **one
distributed trace** that flows **browser → Effect backend → simulated DB work**,
visible live in Maple's local-mode UI.

```
┌──────────────┐   HTTP + traceparent   ┌──────────────┐
│   todo-web    │ ─────────────────────▶ │   todo-api    │
│ React +       │                        │ Effect (Bun)  │
│ effect-atom   │                        │ Ref store     │
└──────┬───────┘                        └──────┬────────┘
       │  OTLP                                  │  OTLP
       └──────────────┬───────────────────────┘
                      ▼
        maple start  (OTLP ingest :4318, embedded ClickHouse)
```

Both ends are instrumented with `@maple-dev/effect-sdk` (client + server preset).
Because both speak Effect's HTTP stack, every request auto-carries a W3C
`traceparent` header, so the browser span and server span share one trace —
which is what draws the `todo-web → todo-api` edge on Maple's service map.

## Stack

- **Frontend** — React + Vite + [`effect-atom`](https://github.com/tim-smart/effect-atom),
  talking to the backend through a shared `HttpApi` contract (`shared/api.ts`).
- **Backend** — Effect (v4 beta) HTTP server on Bun implementing that contract,
  with a `Ref`-backed in-memory store. Adds nested `db.*` spans, artificial
  latency, structured logs, and an occasional simulated failure so Maple's
  Errors / Slow Traces / Logs / Service Map all have data.
- **Sink** — Maple local mode (`maple start`).

## Run it

From the repo root, once: `bun install`.

Then three terminals:

```bash
# 1. Telemetry sink (embedded ClickHouse, OTLP on :4318)
maple start

# 2. Effect backend  → http://localhost:4500
cd examples/effect-todo && bun run server

# 3. React frontend  → http://localhost:4501
cd examples/effect-todo && bun run web
```

Open <http://localhost:4501>, add / toggle / delete a few todos (a few toggles
fail on purpose). Then explore the telemetry:

```bash
maple services                 # lists todo-web AND todo-api
maple service-map              # shows the todo-web → todo-api edge
maple traces                   # recent traces; copy an id…
maple trace <id>               # …to see the browser → api → db.* span tree
maple errors                   # the ToggleFailedError group
maple logs                     # todo.created / todo.toggled / …
```

…or open the local-mode dashboard the `maple start` banner prints.

## Config

Both SDKs default to the local sink. Override with env vars if needed:

| var                   | side   | default                 |
| --------------------- | ------ | ----------------------- |
| `MAPLE_ENDPOINT`      | server | `http://127.0.0.1:4318` |
| `VITE_MAPLE_ENDPOINT` | web    | `http://127.0.0.1:4318` |
| `VITE_API_BASE_URL`   | web    | `http://127.0.0.1:4500` |
| `PORT`                | server | `4500`                  |

## Layout

```
shared/api.ts        # the HttpApi contract (Schema models + endpoints), used by both ends
server/main.ts       # Bun server: HttpApiBuilder handler + CORS + Maple server telemetry
server/TodoService.ts # Ref store; nested spans, latency, logs, simulated failures
web/src/lib/         # otel.ts (client tracing), atom-client.ts, registry.ts, effect-atom.ts
web/src/App.tsx      # the todo UI
```
