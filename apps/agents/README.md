# @maple/agents

A minimal **Electric Agents** runtime for Maple — a hello-world multi-agent chat
(three philosopher agents: Socrates, Camus, Simone) that proves the Electric Agents
stack works end-to-end and routes its LLM calls through **OpenRouter** (the same
provider Maple uses), not Anthropic directly.

Replies **stream token-by-token** into the chat, and a **"{agent} is thinking…"**
indicator shows while an agent is generating. Each agent emits its reply as assistant
prose (which streams to its own timeline); the finished text is committed to the shared
chatroom so the other agents — and the UI — see it.

## The `assistant` agent (powers Maple web's `/electric-chat`)

Besides the philosophers, this runtime registers a single 1:1 **`assistant`** entity
([src/server/assistant-agent.ts](src/server/assistant-agent.ts)) — Maple's observability
assistant. It replies to every message, streams prose, and has **read-only Maple tools**
(`list_services`, `find_errors`) that call the Maple API's MCP endpoint
([src/server/maple-mcp.ts](src/server/maple-mcp.ts)) with the internal service token
(`Bearer maple_svc_$INTERNAL_SERVICE_TOKEN` + `X-Org-Id`). It's consumed by the comparison
route `/electric-chat` in `apps/web` (next to the existing `/chat`).

Run order for the web comparison: `bun run infra` → `bun run dev:server` (this app, `:4700`)
→ the **Maple API** (`bun --filter @maple/api dev:app`, `:3472`, for tools) → `apps/web`.

The tools call the Maple API's `/mcp` over the MCP SDK and return real data (verified:
`list_services` renders a live service table). If `apps/api` isn't running the assistant
reports the tool failed and still answers.

> Note: `/mcp` previously hung on `initialize` locally — the `toWebHandler` pass-through
> middleware in `apps/api/src/worker.ts` had decayed to an identity function (elided), which
> stopped unsticking the RpcServer request-scope hang. Restoring a real effectful wrapper
> fixed it. See the comment at `apps/api/src/worker.ts`.

**apps/web note:** the web route needs a single `@tanstack/db` instance — its `vite.config.ts`
aliases `@tanstack/db` to one copy, otherwise the durable-stream client and `useLiveQuery`
use different copies and live updates don't reach the UI (only the initial snapshot loads).

> **Why a separate app?** Electric Agents' runtime is a long-lived Node HTTP server
> exposing `POST /webhook`. It cannot run inside Maple's Cloudflare Workers API, so it
> lives here as its own workspace.

## Architecture

```
Web UI (Vite, :5175) ──/api──▶ this Node app (:4700)
   │  reads live messages                  │  write user message to shared state
   │  (durable-streams) from :4438         ▼
   │                          Electric Agents Server (docker, :4438) ──webhook──▶ runtime (:4700)
   ▲                            │  durable streams (Postgres + LMDB)        │ dispatches to
   └────────────────────────────┴── agent writes reply ◀── ctx.useAgent() → │ the agent handler
                                                              OpenRouter LLM ┘
```

Three docker services back it (see `docker-compose.yml`): Postgres, Electric, and the
Electric Agents Server. Only the agents-server is published, on `:4438` (it also
listens on `:4438` inside the container — its `BASE_URL` must resolve the same from
the host and from within Docker). This avoids colliding with any other Electric or
durable-streams container (e.g. on `3333` / `4437`).

## Run it

```bash
# 1. Install deps (from repo root)
bun install

# 2. Bring up infra (Postgres + Electric + agents-server)
cd apps/agents
bun run infra            # docker compose up -d
docker compose ps        # wait for all three healthy/started

# 3. Configure the LLM key
cp .env.example .env
# set OPENROUTER_API_KEY=...  (reuse Maple's OpenRouter key)

# 4. Start the runtime server + web UI
bun run dev              # runs the agents server (:4700) AND the chat UI (:5175)
```

Then open **<http://localhost:5175>** — create a room, add agents from the right-hand
panel, and chat. Name an agent in your message ("Camus, …") to be sure they reply;
unaddressed messages get answered only ~half the time by design.

> `bun run dev` runs both processes. To run them separately use `bun run dev:server`
> and `bun run dev:ui`. The UI (Vite) proxies `/api` to the server on `:4700` and
> connects to the agents-server (`:4438`) directly for the live message stream.

## Drive it (CLI / REST)

If you'd rather not use the UI — via the bundled CLI (`@electric-ax/agents`):

```bash
bun run agents spawn /socrates/demo-1 --args '{"chatroomId":"demo"}'
bun run agents send  /socrates/demo-1 "Is remote work better?"
bun run agents observe /socrates/demo-1
```

Or via REST (mirrors the chat-starter API):

```bash
# create a room (spawns one random philosopher)
curl -s -XPOST localhost:4700/api/rooms -d '{"name":"cafe"}'
# -> {"id":"<roomId>", ...}

# add the other two so they can debate each other
curl -s -XPOST localhost:4700/api/rooms/<roomId>/agent -d '{"type":"camus"}'
curl -s -XPOST localhost:4700/api/rooms/<roomId>/agent -d '{"type":"simone"}'

# send a message; agents wake on the shared-state change and reply
curl -s -XPOST localhost:4700/api/rooms/<roomId>/message -d '{"text":"Is the absurd worth living?"}'
```

Inspect the durable timeline (wake → useAgent → streamed prose → shared-state write) in
`logs/*.jsonl`, or in the agents-server UI at <http://localhost:4438>.

## Notes / out of scope

- **Model:** `moonshotai/kimi-k2.5` via OpenRouter. Maple's gateway uses the `:nitro`
  routing variant, but that suffix isn't a pi-ai registry key — forcing it would mean
  passing a full custom `Model` object to `ctx.useAgent`. Base id is enough here.
- **Key:** a plain `OPENROUTER_API_KEY` env var. Org-scoped encrypted keys
  (`OrgOpenRouterSettingsService` + D1) are intentionally out of scope.
- No Maple-data tools and no production deploy — local dev only. (A minimal Vite + React
  chat UI is included under `src/ui/`.)

## Gotchas (why the config looks the way it does)

- **Server version is pinned to `0.4.9`.** The runtime (`@electric-ax/agents-runtime@0.3.4`)
  sends a `default_dispatch_policy`; only agents-server `>= 0.4.x` understands it.
  The `:latest` tag can resolve to a stale cached image — pin explicitly.
- **`SERVE_URL` uses `host.docker.internal`,** not `localhost`: the agents-server runs in
  Docker and must reach this host process to deliver wakes.
- **The server runs on `4438` both inside the container and on the host.** `BASE_URL` is
  used for the runtime's wake "claim callbacks" (host side) *and* internal subscription
  callbacks (container side), so both must resolve `localhost:4438` to the same server.
- **Webhook signature verification is disabled** (`webhookSignature: false` in
  `createRuntimeHandler`) because the local agents-server isn't configured to sign.
- **Env precedence:** `process.loadEnvFile` is first-wins. The app loads `apps/agents/.env`
  *first* (so its `AGENTS_URL`/`PORT`/`SERVE_URL` win), then repo-root `.env.local` for the
  shared `OPENROUTER_API_KEY`.
- **Streaming capture (server):** agents reply as prose (no `send_message` tool). The handler
  reads the finished text from its own timeline after `run()` — the `texts` rows carry no
  content, so it concatenates the `textDeltas` (`delta` chunks, ordered by `_seq`) for the new
  run. `ctx.db` syncs from the durable stream *asynchronously*, so the read retries briefly.
- **Silence sentinel:** with no tool to "not call", an agent opts out of a turn by replying
  `PASS`; the handler drops it (and strips a trailing `PASS` a model may append to a real reply).
- **Live updates need an established subscription:** the browser loads an initial snapshot, then
  long-polls for live updates. Messages sent in the first instant after connecting can be missed
  until the subscription settles — give the room a moment after it shows "live".
