import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "plan_tests", Path(__file__).with_name("plan-tests.py")
)
planner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(planner)


class TestPlan(unittest.TestCase):
    def assert_coverage(self, suites, matrix):
        for suite in suites:
            lanes = [
                lane for lane in matrix["include"] if suite["name"] in lane["filters"]
            ]
            self.assertTrue(lanes, suite["name"])
            shards = [
                arg.split("=")[1]
                for lane in lanes
                for arg in lane["args"]
                if arg.startswith("--shard=")
            ]
            if shards:
                self.assertEqual(
                    sorted(shards),
                    sorted(f"{i}/{len(shards)}" for i in range(1, len(shards) + 1)),
                )
                self.assertTrue(
                    all(lane["filters"] == [suite["name"]] for lane in lanes)
                )
            else:
                self.assertEqual(len(lanes), 1)
            if suite["vitest"]:
                self.assertTrue(
                    all(
                        lane["estimated-seconds"] <= planner.TARGET_SECONDS
                        for lane in lanes
                    )
                )
            else:
                self.assertEqual(lanes[0]["args"], [])
        self.assertEqual(
            {s["name"] for s in suites},
            {name for lane in matrix["include"] for name in lane["filters"]},
        )
        names = [lane["name"] for lane in matrix["include"]]
        self.assertEqual(len(names), len(set(names)))

    def test_current_and_fivefold_growth(self):
        suites = planner.discover()
        self.assertIn("@maple/backend", [s["name"] for s in suites])
        self.assertNotIn("@maple/ingest", [s["name"] for s in suites])
        self.assertNotIn("@maple/slack-agent", [s["name"] for s in suites])
        current = planner.plan(suites)
        grown = [{**s, "files": s["files"] * 5} for s in suites]
        future = planner.plan(grown)
        self.assert_coverage(suites, current)
        self.assert_coverage(grown, future)
        self.assertGreater(len(future["include"]), len(current["include"]))
        self.assertLessEqual(len(future["include"]), 256)

    def test_new_workspace_and_order_independence(self):
        suites = [
            {"name": "@new/tests", "files": 500, "vitest": True},
            {"name": "@new/empty", "files": 0, "vitest": True},
        ]
        self.assert_coverage(suites, planner.plan(suites))
        self.assertEqual(planner.plan(suites), planner.plan(list(reversed(suites))))

    def test_matrix_limit_is_explicit(self):
        with self.assertRaisesRegex(ValueError, "256"):
            planner.plan([{"name": "huge", "files": 100000, "vitest": True}])


class TestRunner(unittest.TestCase):
    def run_lane(self, args, returncode=0, elapsed=10):
        import json
        import os
        import runpy
        from types import SimpleNamespace
        from unittest.mock import patch

        lane = {
            "name": "fixture",
            "filters": ["@fixture/one", "@fixture/two"],
            "args": args,
        }
        with (
            patch.dict(os.environ, {"TEST_LANE": json.dumps(lane)}, clear=True),
            patch(
                "subprocess.run", return_value=SimpleNamespace(returncode=returncode)
            ) as run,
            patch("time.monotonic", side_effect=[0, elapsed]),
            patch("builtins.print"),
            self.assertRaises(SystemExit) as result,
        ):
            runpy.run_path(
                str(Path(__file__).with_name("run-tests.py")), run_name="__main__"
            )
        return result.exception.code, run.call_args.args[0]

    def test_vitest_arguments_and_failure_propagation(self):
        code, command = self.run_lane(["--shard=2/5", "--maxWorkers=2"], returncode=7)
        self.assertEqual(code, 7)
        self.assertEqual(
            command,
            [
                "bun",
                "turbo",
                "test",
                "--concurrency=1",
                "--filter=@fixture/one",
                "--filter=@fixture/two",
                "--",
                "--shard=2/5",
                "--maxWorkers=2",
            ],
        )

    def test_bun_receives_no_vitest_arguments(self):
        code, command = self.run_lane([])
        self.assertEqual(code, 0)
        self.assertNotIn("--", command)

    def test_slow_passing_suite_fails_budget(self):
        code, _ = self.run_lane([], elapsed=241)
        self.assertEqual(code, 1)
