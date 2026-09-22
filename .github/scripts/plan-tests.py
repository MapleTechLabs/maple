"""Size CI lanes from tracked test files; Vitest remains the authority on discovery."""

import fnmatch
import json
import math
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
# Seconds/file estimates from CI run 35671651855. Backend includes PGlite boot;
# web has many cheap pure tests. Unknown suites get the conservative default.
SECONDS_PER_FILE = {"@maple/backend": 3, "@maple/web": 0.8}
TARGET_SECONDS = 100
STARTUP_SECONDS = 5


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


def plan(suites):
    lanes, small = [], []
    for suite in sorted(suites, key=lambda s: s["name"]):
        name = suite["name"]
        weight = max(1, suite["files"]) * SECONDS_PER_FILE.get(name, 1.5)
        if not suite["vitest"]:
            lanes.append(
                {
                    "name": name,
                    "filters": [name],
                    "args": [],
                    "estimated-seconds": weight + STARTUP_SECONDS,
                }
            )
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
    # First-fit decreasing packs small suites without ever running two Vitests
    # on the same runner at once (Turbo concurrency=1).
    groups = []
    for name, weight in sorted(small, key=lambda item: (-item[1], item[0])):
        group = next(
            (g for g in groups if g["estimated-seconds"] + weight <= TARGET_SECONDS),
            None,
        )
        if group is None:
            group = {
                "name": f"small-{len(groups) + 1}",
                "filters": [],
                "args": ["--maxWorkers=2"],
                "estimated-seconds": 0,
            }
            groups.append(group)
        group["filters"].append(name)
        group["estimated-seconds"] += weight
    lanes.extend(groups)
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
