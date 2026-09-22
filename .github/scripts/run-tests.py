"""Run the original workspace scripts with bounded CPU and a visible wall budget."""

import json
import os
import subprocess
import time
from pathlib import Path

lane = json.loads(os.environ["TEST_LANE"])
command = ["bun", "turbo", "test", "--concurrency=1"]
command.extend(f"--filter={name}" for name in lane["filters"])
if lane["args"]:
    command.extend(["--", *lane["args"]])
start = time.monotonic()
result = subprocess.run(command, check=False)
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
raise SystemExit(result.returncode or int(elapsed > budget))
