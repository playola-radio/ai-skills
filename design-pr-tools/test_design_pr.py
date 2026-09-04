import json
import os
import shutil
import subprocess
import tempfile
import textwrap
import unittest

import design_pr

REVIEW_CLEAN = textwrap.dedent("""\
    ---
    audit_status: clean
    blocking_findings: 0
    tradeoffs_open: 0
    audited_at: 2026-09-04T16:00:00Z
    repo_root: /tmp/x
    branch: briankeane/design-foo
    commit: abc123
    reviewed_nodes: [bi8Au, wPnEc]
    sources:
      - docs/context/features/shows.md
      - server/src/api/station/ENDPOINTS.md
    ---
    ## Obvious findings (proposed fixes, not applied)
    none
    ## Owner tradeoffs (resolved in decisions.md)
    none
    ## Passed dimensions
    all
    """)

DECISIONS = textwrap.dedent("""\
    ## D1 — Keep categories versioned?
    Status: superseded
    Options: A yes / B no
    Chosen: A
    Reason: first pass
    Affects: StationCategory

    ## D2 — Keep categories versioned?
    Status: active
    Supersedes: D1
    Options: A yes / B no
    Chosen: B
    Reason: changed mind
    Affects: StationCategory, GET /v1/stations/:id
    """)


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


class ParseFrontMatterTest(unittest.TestCase):
    def test_parses_scalars_inline_lists_and_block_lists(self):
        fm = design_pr.parse_front_matter(REVIEW_CLEAN)
        self.assertEqual(fm["audit_status"], "clean")
        self.assertEqual(fm["tradeoffs_open"], 0)
        self.assertEqual(fm["reviewed_nodes"], ["bi8Au", "wPnEc"])
        self.assertEqual(fm["sources"], ["docs/context/features/shows.md", "server/src/api/station/ENDPOINTS.md"])

    def test_missing_front_matter_returns_empty(self):
        self.assertEqual(design_pr.parse_front_matter("# no header\n"), {})


class ParseDecisionsTest(unittest.TestCase):
    def test_parses_entries_status_and_supersedes(self):
        entries = design_pr.parse_decisions(DECISIONS)
        self.assertEqual([e["id"] for e in entries], ["D1", "D2"])
        self.assertEqual(entries[0]["status"], "superseded")
        self.assertEqual(entries[1]["supersedes"], "D1")
        self.assertEqual(entries[1]["affects"], ["StationCategory", "GET /v1/stations/:id"])

    def test_active_entries_only(self):
        entries = design_pr.parse_decisions(DECISIONS)
        self.assertEqual([e["id"] for e in design_pr.active_decisions(entries)], ["D2"])


class StateTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.feature = os.path.join(self.dir, "design", "features", "foo")
        os.makedirs(self.feature)

    def tearDown(self):
        shutil.rmtree(self.dir)

    def test_no_brief_is_start(self):
        s = design_pr.compute_state(self.feature)
        self.assertEqual((s["state"], s["next"], s["agent"]), ("start", "begin-design-pr", "repo"))

    def test_brief_without_review_is_designing(self):
        write(os.path.join(self.feature, "brief.md"), "# Foo — Design brief\nSlug: foo\n")
        s = design_pr.compute_state(self.feature)
        self.assertEqual((s["state"], s["next"], s["agent"]), ("designing", "begin-pen-session", "pen"))

    def test_blocked_review_is_fixing(self):
        write(os.path.join(self.feature, "brief.md"), "x")
        write(os.path.join(self.feature, "REVIEW.md"), REVIEW_CLEAN.replace("audit_status: clean", "audit_status: blocked"))
        s = design_pr.compute_state(self.feature)
        self.assertEqual((s["state"], s["next"], s["agent"]), ("fixing", "audit-pen-designs", "pen"))

    def test_clean_review_without_design_is_ready_for_spec(self):
        write(os.path.join(self.feature, "brief.md"), "x")
        write(os.path.join(self.feature, "REVIEW.md"), REVIEW_CLEAN)
        s = design_pr.compute_state(self.feature)
        self.assertEqual((s["state"], s["next"], s["agent"]), ("ready_for_spec", "finish-design-pr", "repo"))

    def test_design_older_than_export_is_stale(self):
        write(os.path.join(self.feature, "brief.md"), "x")
        write(os.path.join(self.feature, "REVIEW.md"), REVIEW_CLEAN)
        write(os.path.join(self.feature, "pen-nodes.json"), json.dumps({"exportedAt": "2026-09-05T10:00:00Z", "frames": []}))
        write(os.path.join(self.feature, "DESIGN.md"), "# Foo — Design\nLast exported: 2026-09-04\n")
        s = design_pr.compute_state(self.feature)
        self.assertEqual((s["state"], s["next"], s["agent"]), ("spec_stale", "finish-design-pr", "repo"))

    def test_current_design_is_ready_to_ship(self):
        write(os.path.join(self.feature, "brief.md"), "x")
        write(os.path.join(self.feature, "REVIEW.md"), REVIEW_CLEAN)
        write(os.path.join(self.feature, "pen-nodes.json"), json.dumps({"exportedAt": "2026-09-04T10:00:00Z", "frames": []}))
        write(os.path.join(self.feature, "DESIGN.md"), "# Foo — Design\nLast exported: 2026-09-04\n")
        s = design_pr.compute_state(self.feature)
        self.assertEqual((s["state"], s["next"], s["agent"]), ("ready_to_ship", "/ship then /fix-review", "repo"))


DESIGN_GOOD = textwrap.dedent("""\
    # Foo — Design
    Status: Proposed
    Feature ID: foo
    Repos: playola
    Design PR: pending
    Last exported: 2026-09-04

    ## Summary
    Foo lets curators do a thing.

    ## User flows
    | Flow | Surface | Entry point | Result | Frames |
    |---|---|---|---|---|
    | Create foo | website | Station page | Foo exists | `bi8Au` |

    ## Design frames
    | Surface | Status | Pen file | Node ID | PNG | Notes |
    |---|---|---|---|---|---|
    | Overview | Proposed | design/playola.pen | `bi8Au` | exports/overview--bi8Au.png | |

    ## Existing models
    | Model | Current role | Relevant fields | Change |
    |---|---|---|---|
    | Station | owner | id, name | adds fooId |

    ## Model changes
    | Model | Field | Kind | Type | Nullable | Source | Notes |
    |---|---|---|---|---|---|---|
    | Station | fooId | stored | uuid | yes | Station row | |
    | Station | fooName | populated | string | yes | Foo.name | |

    ## New models
    | Model | Field | Kind | Type | Nullable | Source | Notes |
    |---|---|---|---|---|---|---|
    | Foo | id | stored | uuid | no | Foo row | |

    ```yaml
    Foo:
      table: foos
    ```

    ## Data invariants
    | Invariant | Enforced by | Failure if violated |
    |---|---|---|
    | one foo per station | unique index | duplicate foos |

    ## Endpoint changes
    | Method | Path | Auth | Purpose | Existing/New |
    |---|---|---|---|---|
    | POST | /v1/foos | required | create | New |

    ### POST /v1/foos
    Request:
    ```json
    {"stationId": "abc"}
    ```
    Response:
    ```json
    {"id": "def", "stationId": "abc"}
    ```

    ### DELETE /v1/foos/:id
    Request: no body
    Response: no body

    ## Surfaces
    | Repo | Surface | Change | Frames | Notes |
    |---|---|---|---|---|
    | playola | website station page | add foo row | `bi8Au` | |

    ## Implementation handoff
    | Area | Required work | Source |
    |---|---|---|
    | server | model + endpoint | this doc |

    ## Out of scope
    - Frame `wPnEc` (exploration only)

    ## Rejected alternatives
    - Storing foo on the category.

    ## Open questions
    (must be empty before the design PR is opened)
    """)

NODES_GOOD = {
    "exportedAt": "2026-09-04T16:00:00Z",
    "penFile": "design/playola.pen",
    "variables": {},
    "frames": [
        {"id": "bi8Au", "name": "Overview", "png": "exports/overview--bi8Au.png", "node": {"id": "bi8Au"}},
        {"id": "wPnEc", "name": "Modal", "png": "exports/modal--wPnEc.png", "node": {"id": "wPnEc"}},
    ],
}


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


class CheckTest(unittest.TestCase):
    def setUp(self):
        self.repo = tempfile.mkdtemp()
        git(self.repo, "init", "-q")
        git(self.repo, "config", "user.email", "t@t")
        git(self.repo, "config", "user.name", "t")
        self.feature = os.path.join(self.repo, "design", "features", "foo")
        write(os.path.join(self.repo, "design", "playola.pen"), "{}")
        write(os.path.join(self.feature, "brief.md"), "x")
        write(os.path.join(self.feature, "REVIEW.md"), REVIEW_CLEAN)
        write(os.path.join(self.feature, "decisions.md"), DECISIONS)
        write(os.path.join(self.feature, "DESIGN.md"), DESIGN_GOOD)
        write(os.path.join(self.feature, "pen-nodes.json"), json.dumps(NODES_GOOD))
        for name in ("overview--bi8Au.png", "modal--wPnEc.png"):
            write(os.path.join(self.feature, "exports", name), "png")
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-qm", "design")

    def tearDown(self):
        shutil.rmtree(self.repo)

    def errors(self):
        return design_pr.run_checks(self.feature)

    def set_design(self, old, new):
        text = read_file(os.path.join(self.feature, "DESIGN.md"))
        assert old in text, old
        write(os.path.join(self.feature, "DESIGN.md"), text.replace(old, new))

    def test_good_fixture_passes(self):
        self.assertEqual(self.errors(), [])

    def test_review_not_clean_fails(self):
        write(os.path.join(self.feature, "REVIEW.md"), REVIEW_CLEAN.replace("audit_status: clean", "audit_status: blocked"))
        self.assertTrue(any("audit_status" in e for e in self.errors()))

    def test_open_tradeoffs_fail(self):
        write(os.path.join(self.feature, "REVIEW.md"), REVIEW_CLEAN.replace("tradeoffs_open: 0", "tradeoffs_open: 2"))
        self.assertTrue(any("tradeoffs_open" in e for e in self.errors()))

    def test_bad_kind_fails(self):
        self.set_design("| Station | fooId | stored |", "| Station | fooId | saved |")
        self.assertTrue(any("Kind" in e and "saved" in e for e in self.errors()))

    def test_frame_in_design_missing_from_nodes_fails(self):
        self.set_design("| `bi8Au` | exports/overview--bi8Au.png", "| `zzzzz` | exports/overview--bi8Au.png")
        self.assertTrue(any("zzzzz" in e for e in self.errors()))

    def test_frame_in_nodes_missing_from_design_and_out_of_scope_fails(self):
        self.set_design("- Frame `wPnEc` (exploration only)", "- nothing")
        self.assertTrue(any("wPnEc" in e for e in self.errors()))

    def test_missing_png_fails(self):
        os.remove(os.path.join(self.feature, "exports", "overview--bi8Au.png"))
        self.assertTrue(any("overview--bi8Au.png" in e for e in self.errors()))

    def test_empty_json_body_fails(self):
        self.set_design('{"stationId": "abc"}', "{}")
        self.assertTrue(any("POST /v1/foos" in e and "Request" in e for e in self.errors()))

    def test_invalid_json_body_fails(self):
        self.set_design('{"id": "def", "stationId": "abc"}', '{"id": def}')
        self.assertTrue(any("POST /v1/foos" in e and "Response" in e for e in self.errors()))

    def test_open_question_fails(self):
        self.set_design("(must be empty before the design PR is opened)", "(must be empty before the design PR is opened)\n- Should foos expire?")
        self.assertTrue(any("Open questions" in e for e in self.errors()))

    def test_placeholder_fails(self):
        self.set_design("Foo lets curators do a thing.", "TBD")
        self.assertTrue(any("TBD" in e for e in self.errors()))

    def test_empty_section_fails(self):
        self.set_design("- Storing foo on the category.", "")
        self.assertTrue(any("Rejected alternatives" in e for e in self.errors()))

    def test_pen_changed_after_export_commit_fails(self):
        write(os.path.join(self.repo, "design", "playola.pen"), '{"v": 2}')
        git(self.repo, "add", ".")
        git(self.repo, "commit", "-qm", "canvas edit")
        self.assertTrue(any("exports are stale" in e for e in self.errors()))

    def test_dirty_pen_with_clean_exports_fails(self):
        write(os.path.join(self.repo, "design", "playola.pen"), '{"v": 3}')
        self.assertTrue(any("exports are stale" in e for e in self.errors()))

    def test_dirty_pen_and_dirty_exports_pass(self):
        write(os.path.join(self.repo, "design", "playola.pen"), '{"v": 3}')
        nodes = dict(NODES_GOOD, exportedAt="2026-09-04T17:00:00Z")
        write(os.path.join(self.feature, "pen-nodes.json"), json.dumps(nodes))
        self.assertEqual(self.errors(), [])

    def test_request_fence_cannot_borrow_response_fence(self):
        self.set_design('Request:\n```json\n{"stationId": "abc"}\n```\nResponse:', "Request:\nResponse:")
        self.assertTrue(any("POST /v1/foos" in e and "Request has no" in e for e in self.errors()))

    def test_superseded_entry_left_active_fails(self):
        write(os.path.join(self.feature, "decisions.md"), DECISIONS.replace("Status: superseded", "Status: active"))
        self.assertTrue(any("D1" in e and "superseded" in e for e in self.errors()))


class OverlapTest(unittest.TestCase):
    def test_reports_shared_targets_between_active_entries(self):
        text = DECISIONS + textwrap.dedent("""\

            ## D3 — Expose category on station GET?
            Status: active
            Options: A yes / B no
            Chosen: A
            Reason: needed by ios
            Affects: GET /v1/stations/:id
            """)
        overlaps = design_pr.overlapping_active(design_pr.parse_decisions(text))
        self.assertEqual(overlaps, [("D2", "D3", "GET /v1/stations/:id")])


def read_file(path):
    with open(path) as f:
        return f.read()


if __name__ == "__main__":
    unittest.main()
