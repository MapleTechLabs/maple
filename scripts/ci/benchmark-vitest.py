"""Repeat real Vitest suites, optionally multiplying isolated projects for load testing."""

import argparse
import json
import subprocess
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SUITES = {"backend": "packages/backend", "ui": "packages/ui", "web": "apps/web"}


def positive(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError("must be positive")
    return number


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite", choices=SUITES, required=True)
    parser.add_argument("--copies", type=positive, default=1)
    parser.add_argument("--workers", type=positive, default=2)
    parser.add_argument("--runs", type=positive, default=3)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    directory = ROOT / SUITES[args.suite]
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    config = None
    results = []
    try:
        if args.copies > 1:
            # Independent projects repeat the actual tests, imports, setup, and
            # teardown while keeping two global workers. No copied source files
            # and no weakened isolation. Native sharding still works across them.
            with tempfile.NamedTemporaryFile(
                mode="w",
                suffix=".config.ts",
                prefix=".vitest-benchmark-",
                dir=directory,
                delete=False,
            ) as file:
                config = Path(file.name)
                base_config = (
                    "vitest.config.ts"
                    if (directory / "vitest.config.ts").exists()
                    else "vite.config.ts"
                )
                file.write(
                    'import { defineConfig } from "vitest/config"\n'
                    f'import base from "./{base_config}"\n'
                    "export default defineConfig(async (env) => {\n"
                    ' const resolved = typeof base === "function" ? await base(env) : await base\n'
                    " const projects = resolved.test?.projects ?? [{ test: {} }]\n"
                    f" const replicas = Array.from({{ length: {args.copies} }}, (_, i) => projects.map(project => {{\n"
                    '  if (typeof project !== "object" || project === null || !("test" in project)) throw new Error("Benchmark expects inline test projects")\n'
                    "  return { ...project, extends: true, test: { ...project.test,\n"
                    '   name: `replica-${i + 1}-${project.test?.name ?? "suite"}`,\n'
                    "   ...(project.test?.browser ? { browser: { ...project.test.browser,\n"
                    "    instances: project.test.browser.instances?.map(instance => ({ ...instance,\n"
                    "     name: `replica-${i + 1}-${project.test.name}-${instance.browser}` })) } } : {}) } }\n"
                    " })).flat()\n"
                    " return { ...resolved, test: { ...resolved.test, projects: replicas } }\n"
                    "})\n"
                )
        for index in range(args.runs):
            report = output / f"run-{index + 1}.json"
            # Do not mistake an old successful report for a failed new invocation.
            report.unlink(missing_ok=True)
            command = [
                "bun",
                "run",
                "test",
                f"--maxWorkers={args.workers}",
                "--reporter=json",
                f"--outputFile={report}",
            ]
            if config:
                command.append(f"--config={config}")
            start = time.monotonic()
            with (output / f"run-{index + 1}.log").open("w") as log:
                result = subprocess.run(
                    command,
                    cwd=directory,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    check=False,
                )
            elapsed = time.monotonic() - start
            data = json.loads(report.read_text()) if report.exists() else {}
            row = {
                "run": index + 1,
                "seconds": round(elapsed, 3),
                "exit": result.returncode,
                "passed": data.get("numPassedTests"),
                "failed": data.get("numFailedTests"),
                "pending": data.get("numPendingTests"),
            }
            results.append(row)
            print(json.dumps(row), flush=True)
            if result.returncode:
                break
    finally:
        if config:
            config.unlink(missing_ok=True)
        (output / "summary.json").write_text(
            json.dumps(
                {
                    "suite": args.suite,
                    "copies": args.copies,
                    "workers": args.workers,
                    "node": subprocess.check_output(
                        ["node", "--version"], text=True
                    ).strip(),
                    "bun": subprocess.check_output(
                        ["bun", "--version"], text=True
                    ).strip(),
                    "vitest": subprocess.check_output(
                        ["node", "-p", 'require("vitest/package.json").version'],
                        cwd=directory,
                        text=True,
                    ).strip(),
                    "runs": results,
                },
                indent=2,
            )
            + "\n"
        )
    return int(any(row["exit"] for row in results))


if __name__ == "__main__":
    raise SystemExit(main())
