---
"@maple/cli": patch
---

Maple Local inserts OTLP exports that arrive together in one statement per table, instead of one statement each. Five traces exports sent at once now each answer in about the time one takes alone, where before each waited for the inserts ahead of it. An export still answers only after its rows are committed, and a query reads every row queued before it.
