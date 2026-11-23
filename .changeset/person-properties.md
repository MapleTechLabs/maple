---
"@maple-dev/effect-sdk": minor
---

`MapleEvents` writes user and account properties. Any `track()` call takes `set`, `setOnce` and `unset` for the user and `groupSet`, `groupSetOnce` and `groupUnset` for the account, and two new calls send them on their own: `identify(userId, { set, setOnce, unset, visitorId })` and `groupIdentify(groupId, properties)`. Passing `visitorId` to `identify` links the device to the user, so their events before sign-in count as theirs.
