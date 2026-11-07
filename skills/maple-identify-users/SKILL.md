---
name: maple-identify-users
description: "Identify signed-in users in an app that already sends telemetry to Maple, so each person gets a page on Maple's Users page with their sessions, traces, logs, errors and events. Triggers on requests like 'identify users for Maple', 'fill the Maple Users page', 'add user.id to my spans', 'tie telemetry to users'."
---

# Identify users for Maple

Maple's Users page lists everyone your telemetry names. A person shows up once any of these carry their id:

- a browser session (`identify()` in `@maple-dev/browser` or `@maple-dev/effect-sdk/client`)
- a span with a `user.id` attribute (`enduser.id` is read too, but write `user.id`)
- a log record with a `user.id` attribute
- a product event with a `user_id`

This skill assumes the app already exports OpenTelemetry to Maple. If nothing reaches Maple yet, run the onboarding skill first: `https://maple.dev/SKILL.md`.

## Step 1: Find where the user is known

Search the repo for the places that resolve the signed-in user: the auth provider's client hook or session callback in the frontend (Clerk, Auth.js, Supabase, Firebase, Auth0, a custom `/me` call), and the auth middleware, request guard or session lookup in each backend service. Identify at those points only, never in individual handlers.

Use the app's stable user id (the database or auth provider id). Never an email or name as the id.

## Step 2: Browser

With `@maple-dev/browser`, call `identify` right after sign-in resolves and clear it on sign-out:

```ts
import { MapleBrowser } from "@maple-dev/browser"

// after sign-in, and on page load when a session already exists
MapleBrowser.identify({
	id: user.id,
	email: user.email, // optional
	username: user.username, // optional
	groupId: org.id, // optional: the company, team or workspace
	groupName: org.name, // optional
})

// on sign-out
MapleBrowser.identify(null)
```

If the user is known when `MapleBrowser.init` runs, pass the same object as `user` in `init()` instead. Each `identify` call replaces the identity; it does not merge.

With `@maple-dev/effect-sdk/client`, use `identify(user.id)` and `clearIdentity()` from `@maple-dev/effect-sdk/client`.

`groupId` and `groupName` are what the Users page groups by. Set them whenever the app has an organization, team or workspace concept.

## Step 3: Backend services

In the auth middleware of each service, once the user is resolved, set the attributes on the **request's root (server) span**, the one the HTTP instrumentation created for the request, not a child span:

```ts
import { trace } from "@opentelemetry/api"

const span = trace.getActiveSpan()
span?.setAttribute("user.id", user.id)
span?.setAttribute("user.email", user.email) // optional
span?.setAttribute("user.name", user.name) // optional
```

The same keys in other languages: Python `span.set_attribute("user.id", ...)`, Go `span.SetAttributes(attribute.String("user.id", ...))`, Java `Span.current().setAttribute("user.id", ...)`, Rust `tracing::Span::current().record("user.id", ...)` (declare the field on the span). In Effect, `Effect.annotateCurrentSpan("user.id", user.id)` inside the request handler's span.

If the app logs through OpenTelemetry, add `user.id` to the log context the same way (structured field or log attribute), so log lines reach the same user page.

Do not put passwords, tokens or other secrets in attributes. Only send `user.email` and `user.name` if the app's privacy policy allows it; the id alone is enough for the page to work.

## Step 4: Verify

1. Run the app, sign in, click around.
2. Open `https://app.maple.dev/users` (EU: `https://app.eu.maple.dev/users`). The user should appear within a minute, with requests and sessions counted.
3. If only some signals show up, check the root server span of a request in the trace view for `user.id`, and check a browser session on the Replays page for the user columns.

Report back which files you changed, which services now set `user.id`, and anything you could not identify (for example a service with no auth context).
