---
title: "Merge duplicate issues and set error grouping yourself"
description: "Merge error issues that are the same bug, split them back out, and name a grouping key in code when the automatic grouping gets it wrong."
date: 2026-11-03
category: errors
authors: [makisuo]
---

Three changes to how errors become issues:

- **Merge issues.** Select issues on the **Errors** page and choose **Merge**, then pick the one
  to keep. Its count and builds include the others, and their future occurrences land on it. A
  merged issue's page links to where it went and has **Unmerge**, which hands back exactly the
  occurrences it brought. Merging is also available from the API and MCP.
- **Set the grouping in code.** Put a `maple.fingerprint` attribute on an error span or its
  exception event, and every error in that service with the same value becomes one issue,
  whatever its stack or message. Use a fixed name for the failure, never a per-request value.
- **Grouping by your own code.** When a stack has frames from your application, frames from
  dependencies and the runtime no longer affect the grouping. An error thrown inside a library now
  groups by the code of yours that called it. Existing issues carried over to the new grouping
  with their state, history and counts.

See [How errors are grouped](/docs/errors/overview#how-errors-are-grouped).
