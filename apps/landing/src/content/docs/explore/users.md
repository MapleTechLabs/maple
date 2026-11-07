---
title: "Users"
description: "One page per signed-in person: their sessions, requests, traces, logs, errors and events. How to identify users so they show up."
group: "Explore"
order: 6
---

The **Users** page lists everyone your telemetry names, and gives each person a page with their sessions, requests, traces, logs, errors, product events and MCP sessions. It stays empty until your SDKs tell Maple who is signed in.

## Let your coding agent do it

Paste this into Claude Code, Codex or Cursor in your repo:

```text
Identify the signed-in users in my app so they show up on Maple's Users page: maple.dev/skills/identify-users.md
```

The [skill](https://maple.dev/skills/identify-users.md) finds where your app resolves the signed-in user and adds the calls below. The empty Users page has the same prompt behind its **Build with your agent** button.

## What makes a user

A person appears once any of these carry their id:

| Source          | How                                                          |
| --------------- | ------------------------------------------------------------ |
| Browser session | `MapleBrowser.identify()` or `user` in `MapleBrowser.init()` |
| Backend span    | a `user.id` attribute (`enduser.id` is read too)             |
| Log record      | a `user.id` attribute                                        |
| Product event   | `user_id`                                                    |

Use your app's stable user id (database or auth provider id), never an email or a name.

## Browser

After sign-in, and on page load when a session already exists:

```ts
import { MapleBrowser } from "@maple-dev/browser"

MapleBrowser.identify({
	id: user.id,
	email: user.email, // optional
	username: user.username, // optional
	groupId: org.id, // optional: groups the Users page by company or team
	groupName: org.name, // optional
})

// on sign-out
MapleBrowser.identify(null)
```

`groupId` and `groupName` are what the page's **Group by** uses. See [Identifying users](/docs/session-replay/browser-sdk#identifying-users) in the Browser SDK docs for `traits` and the init-time form. With the Effect SDK, call `identify(user.id)` and `clearIdentity()` from `@maple-dev/effect-sdk/client`.

## Backend

In your auth middleware, once the user is resolved, set the attributes on the request's root server span:

```ts
import { trace } from "@opentelemetry/api"

const span = trace.getActiveSpan()
span?.setAttribute("user.id", user.id)
span?.setAttribute("user.email", user.email) // optional, shown as the user's email
span?.setAttribute("user.name", user.name) // optional, shown as the user's name
```

Any OpenTelemetry SDK works: the key is `user.id` in every language. Put the same attribute on your structured logs so log lines land on the user's page too.

## Check it

Sign in to your app, click around, and open **Users**. The person shows up within a minute. If the page is still empty, widen the time range, then open one of your traces and check the root span carries `user.id`.
