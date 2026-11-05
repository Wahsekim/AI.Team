#!/usr/bin/env python3
"""OpenProject BASIC board helper (no Enterprise action boards).

A basic board is a grid of manually ordered work-package queries; nothing moves
by itself. The PM mirrors every status transition with a card move here.
The order endpoint (/api/v3/queries/{id}/order: GET map, PATCH {"delta":
{id: pos | -1}}) was observed on ONE pilot server; OpenProject API behaviour is
server/version-specific - re-verify before relying on it elsewhere.

Usage:
  scripts/op-board.py create                 # create the basic board + lists once
  scripts/op-board.py show                   # print lists and their cards
  scripts/op-board.py move <WP_ID> <LIST>    # move a card: journaled, target-first, read back
  scripts/op-board.py reconcile              # resume a journaled move that was interrupted
  scripts/op-board.py delete-grid <GRID_ID>  # remove an unusable board grid (explicit)
Env: OP_URL and OP_PROJECT (required); OP_LISTS (comma-separated, optional);
     OP_BOARD_STATE (state file, default profiles/op-board.json).
Token: $OP_API_KEY or ~/.config/openproject/token (never printed).
"""
import base64, json, os, sys, urllib.error, urllib.request, uuid
from pathlib import Path

DEFAULT_LISTS = ["Backlog", "Ready", "In progress", "In testing", "Needs decision", "Done"]
BOARD_NAME = "Kanban (basic)"


def env(name):
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"{name} is required: set the {name} environment variable")
    return value


def lists():
    raw = os.environ.get("OP_LISTS", "")
    return [s.strip() for s in raw.split(",") if s.strip()] or DEFAULT_LISTS


def state_path():
    default = Path(__file__).resolve().parent.parent / "profiles" / "op-board.json"
    return Path(os.environ.get("OP_BOARD_STATE") or default)


def token():
    t = os.environ.get("OP_API_KEY") or (Path.home() / ".config/openproject/token").read_text().strip()
    return base64.b64encode(f"apikey:{t}".encode()).decode()


def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(env("OP_URL") + path, method=method, data=data,
                                 headers={"Authorization": "Basic " + token(), "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {path} -> HTTP {e.code}: {e.read().decode()[:400]}")


TRANSPORT = api  # tests replace this with an in-memory fake


def call(method, path, body=None):
    return TRANSPORT(method, path, body)


def read_state():
    p = state_path()
    return json.loads(p.read_text()) if p.exists() else {}


def write_state(st):
    p = state_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(st, indent=1) + "\n")


def order(qid):
    return {str(k): v for k, v in call("GET", f"/api/v3/queries/{qid}/order").items()}


def add_to(qid, wp):
    current = order(qid)
    if wp in current:
        return
    call("PATCH", f"/api/v3/queries/{qid}/order", {"delta": {wp: (max(current.values()) + 1) if current else 0}})


def remove_from(qid, wp):
    call("PATCH", f"/api/v3/queries/{qid}/order", {"delta": {wp: -1}})


def query_body(name, project_href):
    return {"name": name, "public": True, "hidden": True, "showHierarchies": False,
            "filters": [{"_links": {"filter": {"href": "/api/v3/queries/filters/manualSort"},
                                    "operator": {"href": "/api/v3/queries/operators/ow"}, "values": []}}],
            "sortBy": [{"href": "/api/v3/queries/sort_bys/manualSorting-asc"}],
            "_links": {"project": {"href": project_href}}}


def widget(column, qid):
    return {"identifier": "work_package_query", "startRow": 1, "endRow": 2,
            "startColumn": column + 1, "endColumn": column + 2,
            "options": {"queryId": str(qid), "filters": [{"manualSort": {"operator": "ow", "values": []}}]}}


def create():
    st = read_state()
    if st.get("grid"):
        raise SystemExit(f"board already recorded: {state_path()}")
    project = env("OP_PROJECT")
    project_href = call("GET", f"/api/v3/projects/{project}")["_links"]["self"]["href"]
    created = [(name, call("POST", "/api/v3/queries", query_body(name, project_href))["id"]) for name in lists()]
    widgets = [widget(i, qid) for i, (_, qid) in enumerate(created)]
    grid = call("POST", "/api/v3/grids", {"name": BOARD_NAME, "rowCount": 1, "columnCount": len(widgets),
                                          "options": {"type": "free"}, "widgets": widgets,
                                          "_links": {"scope": {"href": f"/projects/{project}/boards"}}})
    write_state({**st, "grid": grid["id"], "queries": dict(created)})
    print(f"board created: {env('OP_URL')}/projects/{project}/boards/{grid['id']}  (state: {state_path().name})")


def move(wp, target):
    st = read_state()
    queries = st.get("queries") or {}
    if not queries:
        raise SystemExit("board not recorded yet: run 'create' first")
    if target not in queries:
        raise SystemExit(f"list must be one of {list(queries)}")
    wp = str(int(wp))
    pending = st.get("pending_move")
    if pending and (pending["wp"], pending["target"]) != (wp, target):
        raise SystemExit(f"a journaled move is still pending (#{pending['wp']} -> {pending['target']}); "
                         "run scripts/op-board.py reconcile first")
    journal = pending or {"op": str(uuid.uuid4()), "wp": wp, "target": target}
    write_state({**st, "pending_move": journal})  # journal BEFORE the first mutation
    execute_move({**st, "pending_move": journal})


def execute_move(st):
    j = st["pending_move"]
    wp, target, queries = j["wp"], j["target"], st["queries"]
    add_to(queries[target], wp)
    if wp not in order(queries[target]):
        raise SystemExit(f"#{wp} not visible in '{target}' after add; nothing removed (journal {j['op']} kept)")
    for name, qid in queries.items():
        if name != target and wp in order(qid):
            remove_from(qid, wp)
    where = [name for name, qid in queries.items() if wp in order(qid)]
    if where != [target]:
        raise SystemExit(f"#{wp} is in {where}, expected only '{target}' (journal {j['op']} kept - run reconcile)")
    write_state({k: v for k, v in st.items() if k != "pending_move"})
    print(f"#{wp} -> {target}")


def reconcile():
    st = read_state()
    if not st.get("pending_move"):
        print("no pending move")
        return
    execute_move(st)


def show():
    st = read_state()
    print(f"board {env('OP_URL')}/projects/{env('OP_PROJECT')}/boards/{st['grid']}")
    for name, qid in st["queries"].items():
        ids = [k for k, _ in sorted(order(qid).items(), key=lambda kv: kv[1])]
        subjects = {k: call("GET", f"/api/v3/work_packages/{k}")["subject"].split()[0] for k in ids}
        print(f"  {name:<15} {len(ids):>2}  " + " ".join(f"{subjects[k]}(#{k})" for k in ids))
    if st.get("pending_move"):
        print(f"  PENDING MOVE: #{st['pending_move']['wp']} -> {st['pending_move']['target']} (run reconcile)")


def delete_grid(gid):
    g = call("GET", f"/api/v3/grids/{gid}")
    print(f"deleting grid {gid} '{g.get('name')}' options={g.get('options')}")
    call("DELETE", f"/api/v3/grids/{gid}")
    print("deleted")


def main(argv):
    arity = {"create": 0, "show": 0, "move": 2, "reconcile": 0, "delete-grid": 1}
    if not argv or argv[0] not in arity or len(argv) - 1 != arity[argv[0]]:
        raise SystemExit(__doc__)
    env("OP_URL")
    env("OP_PROJECT")
    handlers = {"create": create, "show": show, "move": move, "reconcile": reconcile, "delete-grid": delete_grid}
    handlers[argv[0]](*argv[1:])


if __name__ == "__main__":
    main(sys.argv[1:])
