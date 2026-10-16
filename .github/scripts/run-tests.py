"""Run the original workspace scripts with bounded CPU and a visible wall budget."""

import json
import os
import subprocess
import time
from pathlib import Path

lane = json.loads(os.environ["TEST_LANE"])
bun = lane.get("bun-filters", [])
vitest = [name for name in lane["filters"] if name not in bun]
base = ["bun", "turbo", "test", "--concurrency=1"]
commands = []
if vitest:
    command = base + [f"--filter={name}" for name in vitest]
    if lane["args"]:
        command.extend(["--", *lane["args"]])
    commands.append(command)
# Bun suites share the lane but not its Vitest flags, which `bun test` rejects.
if bun:
    commands.append(base + [f"--filter={name}" for name in bun])
start = time.monotonic()
# Both invocations run even after one fails, so a red lane reports every failure.
returncode = 0
for command in commands:
    result = subprocess.run(command, check=False)
    returncode = returncode or result.returncode
elapsed = time.monotonic() - start
# Includes cold dependency builds. The planner targets 100s, leaving ample room
# for setup and runner variance. A single slow file must be fixed/split, not
# concealed by adding shards: Vitest shards files, not individual test cases.
budget = 240
summary = (
    f"{lane['name']}: {elapsed:.1f}s / {budget}s budget (includes dependency builds)\n"
)
print(summary, flush=True)
if os.environ.get("GITHUB_STEP_SUMMARY"):
    with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as output:
        output.write(summary)
if elapsed > budget:
    print(
        "::error::Test lane exceeded 240s. Inspect slow files and update the CI sizing estimates; see docs/ci-performance.md."
    )
raise SystemExit(returncode or int(elapsed > budget))
