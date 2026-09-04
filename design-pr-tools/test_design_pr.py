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


if __name__ == "__main__":
    unittest.main()
