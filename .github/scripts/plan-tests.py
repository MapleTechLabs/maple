"""Size CI lanes from tracked test files; Vitest remains the authority on discovery."""

import fnmatch
import json
import math
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# Vitest seconds/file at two workers, measured on CI run 35725366619 (Duration
# lines, excluding dependency builds). Unknown suites get the conservative default.
SECONDS_PER_FILE = {
    "@maple/api": 2.3,
    "@maple/backend": 1.6,
    "@maple/ai": 1.1,
    "@maple/web": 0.55,
    "@maple/query-engine": 0.45,
    "@maple/ui": 0.45,
    "@maple/domain": 0.4,
}
DEFAULT_SECONDS_PER_FILE = 1
# Every job pays ~30s of checkout/mise/install plus Turbo dependency builds before
# a test runs, and the org runs ~16 jobs at once, so the matrix queued in waves.
# Fewer, fuller lanes beat many short ones on both wall clock and runner minutes.
TARGET_SECONDS = 140
# Per Vitest invocation: Vite startup and Turbo overhead, paid once per suite.
STARTUP_SECONDS = 4


def discover(root=ROOT):
    files = (
        subprocess.check_output(["git", "ls-files", "-z"], cwd=root)
        .decode()
        .split("\0")
    )
    patterns = json.loads((root / "package.json").read_text())["workspaces"]
    suites = []
    for file in files:
        if not re.fullmatch(r"[^/]+/[^/]+/package.json", file):
            continue
        directory = file.removesuffix("/package.json")
        if not any(
            fnmatch.fnmatchcase(directory, p) for p in patterns if not p.startswith("!")
        ):
            continue
        if any(
            fnmatch.fnmatchcase(directory, p[1:]) for p in patterns if p.startswith("!")
        ):
            continue
        package = json.loads((root / file).read_text())
        script = package.get("scripts", {}).get("test")
        if not script or directory == "apps/ingest":  # dedicated Rust workflow
            continue
        count = sum(
            f.startswith(directory + "/")
            and bool(re.search(r"\.(test|spec)\.[cm]?[jt]sx?$", f))
            for f in files
        )
        suites.append(
            {
                "name": package["name"],
                "files": count,
                "vitest": "vitest run" in script,
                "browser-workspace": directory
                if "@vitest/browser-playwright" in package.get("devDependencies", {})
                else "",
            }
        )
    return suites


def pack(suites, prefix, args):
    groups = []
    for name, weight in sorted(suites, key=lambda item: (-item[1], item[0])):
        group = next(
            (g for g in groups if g["estimated-seconds"] + weight <= TARGET_SECONDS),
            None,
        )
        if group is None:
            group = {
                "name": f"{prefix}-{len(groups) + 1}",
                "filters": [],
                "args": list(args),
                "estimated-seconds": 0,
            }
            groups.append(group)
        group["filters"].append(name)
        group["estimated-seconds"] += weight
    return groups


def plan(suites):
    lanes, small, bun = [], [], []
    for suite in sorted(suites, key=lambda s: s["name"]):
        name = suite["name"]
        weight = max(1, suite["files"]) * SECONDS_PER_FILE.get(
            name, DEFAULT_SECONDS_PER_FILE
        )
        if not suite["vitest"]:
            # Bun suites share lanes with each other, never with Vitest flags.
            bun.append((name, weight + STARTUP_SECONDS))
            continue
        shards = math.ceil(weight / (TARGET_SECONDS - STARTUP_SECONDS))
        if shards == 1:
            small.append((name, weight + STARTUP_SECONDS))
        else:
            for index in range(1, shards + 1):
                lanes.append(
                    {
                        "name": f"{name}-{index}-of-{shards}",
                        "filters": [name],
                        "args": [f"--shard={index}/{shards}", "--maxWorkers=2"],
                        "estimated-seconds": weight / shards + STARTUP_SECONDS,
                    }
                )
    # First-fit decreasing packs small suites without ever running two test
    # runners on the same machine at once (Turbo concurrency=1).
    lanes.extend(pack(small, "small", ["--maxWorkers=2"]))
    lanes.extend(pack(bun, "bun", []))
    browser_workspaces = {
        suite["name"]: suite.get("browser-workspace", "") for suite in suites
    }
    for lane in lanes:
        lane["browser-workspace"] = next(
            (
                browser_workspaces[name]
                for name in lane["filters"]
                if browser_workspaces[name]
            ),
            "",
        )
    if len(lanes) > 256:
        raise ValueError(
            "Test matrix exceeds GitHub's 256-job limit; revise the runner budget"
        )
    return {"include": lanes}


if __name__ == "__main__":
    print(json.dumps(plan(discover()), separators=(",", ":")))
