"""Failure-injection tests for scripts/op-board.py (review F-04: a partial move
must never leave a card in no list). No network: TRANSPORT is replaced with an
in-memory fake. Run: PYTHONDONTWRITEBYTECODE=1 python3 -m unittest tests/op_board_test.py"""
import contextlib, importlib.util, io, json, os, re, tempfile, unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "op-board.py"
spec = importlib.util.spec_from_file_location("op_board", SCRIPT)
op_board = importlib.util.module_from_spec(spec)
spec.loader.exec_module(op_board)

ORDER = re.compile(r"^/api/v3/queries/(\d+)/order$")
QUERIES = {"Backlog": 47, "Ready": 48, "In progress": 49, "In testing": 50, "Needs decision": 51, "Done": 52}
ENV = {"OP_URL": "http://fake.invalid", "OP_PROJECT": "demo"}


class FakeOpenProject:
    """Per-query order maps; failures injected per (method, path, nth occurrence)."""

    def __init__(self, orders):
        self.orders = {str(q): {str(k): v for k, v in o.items()} for q, o in orders.items()}
        self.calls, self.seen, self.failures, self.after_call = [], {}, {}, None

    def fail_at(self, method, path, occurrence=1, mode="before"):
        self.failures[(method, path, occurrence)] = mode

    def __call__(self, method, path, body=None):
        self.calls.append((method, path, body))
        n = self.seen.get((method, path), 0) + 1
        self.seen[(method, path)] = n
        mode = self.failures.get((method, path, n))
        if mode == "before":
            raise SystemExit(f"injected failure before {method} {path}")
        m = ORDER.match(path)
        if not m:
            raise AssertionError(f"unexpected call {method} {path}")
        qid = m.group(1)
        result = dict(self.orders[qid]) if method == "GET" else self._patch(qid, body)
        if self.after_call:
            self.after_call(self, method, path, n)
        if mode == "after":
            raise SystemExit(f"injected lost response after {method} {path}")
        return result

    def _patch(self, qid, body):
        for wp, pos in body["delta"].items():
            if pos == -1:
                self.orders[qid].pop(wp, None)
            else:
                self.orders[qid][wp] = pos
        return {}

    def where(self, wp):
        return sorted(q for q, o in self.orders.items() if wp in o)

    def patches(self):
        return [(p, b) for m, p, b in self.calls if m == "PATCH"]


class MoveTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.state = Path(tmp.name) / "op-board.json"
        self.state.write_text(json.dumps({"grid": 14, "queries": QUERIES}))
        env = mock.patch.dict(os.environ, {**ENV, "OP_BOARD_STATE": str(self.state)}, clear=True)
        env.start()
        self.addCleanup(env.stop)
        self.fake = FakeOpenProject({47: {"42": 0, "7": 1}, 48: {"9": 0}, 49: {}, 50: {}, 51: {}, 52: {}})
        op_board.TRANSPORT = self.fake
        self.addCleanup(setattr, op_board, "TRANSPORT", op_board.api)

    def journal(self):
        return json.loads(self.state.read_text()).get("pending_move")

    def run_cli(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            op_board.main(list(argv))
        return out.getvalue()

    def fails(self, *argv):
        with self.assertRaises(SystemExit) as ctx:
            self.run_cli(*argv)
        return str(ctx.exception)

    def test_happy_path_adds_to_target_before_removing_from_source(self):
        out = self.run_cli("move", "42", "Ready")
        self.assertEqual(self.fake.where("42"), ["48"])
        self.assertIn("#42 -> Ready", out)
        self.assertIsNone(self.journal())
        patches = self.fake.patches()
        self.assertEqual(patches[0], ("/api/v3/queries/48/order", {"delta": {"42": 1}}))
        self.assertEqual(patches[1], ("/api/v3/queries/47/order", {"delta": {"42": -1}}))
        self.assertEqual(len(patches), 2)

    def test_target_get_failure_mutates_nothing(self):
        self.fake.fail_at("GET", "/api/v3/queries/48/order", 1)
        self.fails("move", "42", "Ready")
        self.assertEqual(self.fake.where("42"), ["47"])
        self.assertEqual(self.fake.patches(), [])
        self.assertEqual(self.journal()["wp"], "42")

    def test_add_patch_failure_leaves_card_in_source(self):
        self.fake.fail_at("PATCH", "/api/v3/queries/48/order", 1, "before")
        self.fails("move", "42", "Ready")
        self.assertEqual(self.fake.where("42"), ["47"])
        self.assertEqual(self.journal()["target"], "Ready")

    def test_target_readback_failure_removes_nothing_then_reconcile(self):
        self.fake.fail_at("GET", "/api/v3/queries/48/order", 2)
        self.fails("move", "42", "Ready")
        self.assertEqual(self.fake.where("42"), ["47", "48"])
        self.assertEqual([p for p, b in self.fake.patches() if b["delta"].get("42") == -1], [])
        self.assertIsNotNone(self.journal())
        self.run_cli("reconcile")
        self.assertEqual(self.fake.where("42"), ["48"])
        self.assertIsNone(self.journal())

    def test_removal_patch_failure_keeps_target_and_journal(self):
        self.fake.fail_at("PATCH", "/api/v3/queries/47/order", 1, "before")
        self.fails("move", "42", "Ready")
        self.assertEqual(self.fake.where("42"), ["47", "48"])
        self.assertIsNotNone(self.journal())
        self.run_cli("reconcile")
        self.assertEqual(self.fake.where("42"), ["48"])
        self.assertIsNone(self.journal())

    def test_lost_response_on_add_then_reconcile_converges_without_readding(self):
        self.fake.fail_at("PATCH", "/api/v3/queries/48/order", 1, "after")
        self.fails("move", "42", "Ready")
        self.assertEqual(self.fake.where("42"), ["47", "48"])
        self.assertIsNotNone(self.journal())
        self.run_cli("reconcile")
        self.assertEqual(self.fake.where("42"), ["48"])
        self.assertIsNone(self.journal())
        self.assertEqual(len([p for p, _ in self.fake.patches() if p.endswith("/48/order")]), 1)

    def test_lost_response_on_removal_then_same_move_resumes_journal(self):
        self.fake.fail_at("PATCH", "/api/v3/queries/47/order", 1, "after")
        self.fails("move", "42", "Ready")
        self.assertEqual(self.fake.where("42"), ["48"])
        self.assertIsNotNone(self.journal())
        self.run_cli("move", "42", "Ready")
        self.assertEqual(self.fake.where("42"), ["48"])
        self.assertIsNone(self.journal())
        self.assertEqual(len(self.fake.patches()), 2)

    def test_final_readback_failure_keeps_journal_then_reconcile(self):
        self.fake.fail_at("GET", "/api/v3/queries/52/order", 2)
        self.fails("move", "42", "Ready")
        self.assertEqual(self.fake.where("42"), ["48"])
        self.assertIsNotNone(self.journal())
        self.run_cli("reconcile")
        self.assertIsNone(self.journal())

    def test_repeated_move_of_moved_card_is_noop_success(self):
        self.run_cli("move", "42", "Ready")
        before = len(self.fake.patches())
        out = self.run_cli("move", "42", "Ready")
        self.assertEqual(len(self.fake.patches()), before)
        self.assertEqual(self.fake.where("42"), ["48"])
        self.assertIn("#42 -> Ready", out)

    def test_wrong_target_rejected_before_any_call(self):
        msg = self.fails("move", "42", "Nope")
        self.assertIn("list must be one of", msg)
        self.assertEqual(self.fake.calls, [])
        self.assertIsNone(self.journal())

    def test_concurrent_edit_between_get_and_patch(self):
        def racer(fake, method, path, n):
            if method == "GET" and path.endswith("/48/order") and n == 1:
                fake.orders["48"]["99"] = 1
        self.fake.after_call = racer
        self.run_cli("move", "42", "Ready")
        self.assertEqual(self.fake.where("42"), ["48"])
        self.assertIn("99", self.fake.orders["48"])

    def test_duplicate_membership_at_final_readback_exits_nonzero(self):
        def reappear(fake, method, path, n):
            if method == "GET" and path.endswith("/52/order") and n == 1:
                fake.orders["49"]["42"] = 3
        self.fake.after_call = reappear
        msg = self.fails("move", "42", "Ready")
        self.assertIn("In progress", msg)
        self.assertIn("Ready", msg)
        self.assertEqual(self.fake.where("42"), ["48", "49"])
        self.assertIsNotNone(self.journal())

    def test_pending_move_for_another_card_blocks_until_reconcile(self):
        st = json.loads(self.state.read_text())
        self.state.write_text(json.dumps({**st, "pending_move": {"op": "x", "wp": "7", "target": "Done"}}))
        msg = self.fails("move", "42", "Ready")
        self.assertIn("reconcile", msg)
        self.assertEqual(self.fake.calls, [])

    def test_missing_env_fails_clearly(self):
        for missing in ("OP_URL", "OP_PROJECT"):
            env = {k: v for k, v in ENV.items() if k != missing}
            with mock.patch.dict(os.environ, {**env, "OP_BOARD_STATE": str(self.state)}, clear=True):
                msg = self.fails("move", "42", "Ready")
            self.assertIn(missing, msg)
            self.assertEqual(self.fake.calls, [])


if __name__ == "__main__":
    unittest.main()
