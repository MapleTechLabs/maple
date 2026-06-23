import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Redis } from "effect/unstable/persistence"

describe("Redis", () => {
  it.effect("reloads and retries scripts when EVALSHA returns NOSCRIPT", () =>
    Effect.gen(function*() {
      const commands: Array<readonly [command: string, args: ReadonlyArray<string>]> = []
      let evalShaAttempts = 0
      const redis = yield* Redis.make({
        send: (command, ...args) =>
          Effect.suspend(() => {
            commands.push([command, args])
            if (command === "EVALSHA") {
              evalShaAttempts += 1
            }
            if (command === "SCRIPT") {
              return Effect.succeed("sha" as any)
            }
            if (command === "EVALSHA" && evalShaAttempts === 1) {
              return Effect.fail(new Redis.RedisError({ cause: new Error("NOSCRIPT No matching script") }))
            }
            return Effect.succeed("ok")
          })
      })
      const evalScript = redis.eval(
        Redis.script((key: string) => [key], {
          lua: "return KEYS[1]",
          numberOfKeys: 1
        }).withReturnType<string>()
      )

      const result = yield* evalScript("key")

      assert.strictEqual(result, "ok")
      assert.deepStrictEqual(commands.map(([command]) => command), [
        "SCRIPT",
        "EVALSHA",
        "SCRIPT",
        "EVALSHA"
      ])
    }))
})
