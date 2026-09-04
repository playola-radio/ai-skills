#!/usr/bin/env python3
"""Design-PR flow helpers shared by the five design-pr skills.

    python3 design_pr.py state <feature_dir>   # which skill runs next
    python3 design_pr.py check <feature_dir>   # finish-design-pr hard checks

Both Claude and Codex call this instead of re-deriving the rules from prose.
"""
import json
import os
import re
import subprocess
import sys

KINDS = {"stored", "populated", "computed", "request-only", "response-only"}
AUDIT_STATUSES = {"clean", "blocked", "owner_decisions_needed"}


# ---------- parsing ----------

def _coerce(value):
    value = value.strip()
    if re.fullmatch(r"-?\d+", value):
        return int(value)
    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1].strip()
        return [v.strip().strip("'\"") for v in inner.split(",")] if inner else []
    return value.strip("'\"")


def parse_front_matter(text):
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end == -1:
        return {}
    result = {}
    current_list = None
    for line in text[3:end].splitlines():
        if not line.strip():
            continue
        if line.startswith("  - ") and current_list is not None:
            result[current_list].append(line[4:].strip().strip("'\""))
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        if value.strip() == "":
            result[key] = []
            current_list = key
        else:
            result[key] = _coerce(value)
            current_list = None
    return result


def parse_decisions(text):
    entries = []
    for block in re.split(r"^## ", text, flags=re.M)[1:]:
        lines = block.strip().splitlines()
        head = lines[0]
        match = re.match(r"(D\d+)\s+[—-]\s+(.*)", head)
        entry = {"id": match.group(1) if match else head, "title": match.group(2) if match else head,
                 "status": "active", "supersedes": None, "chosen": "", "affects": []}
        for line in lines[1:]:
            key, _, value = line.partition(":")
            key, value = key.strip().lower(), value.strip()
            if key == "status":
                entry["status"] = value
            elif key == "supersedes":
                entry["supersedes"] = value
            elif key == "chosen":
                entry["chosen"] = value
            elif key == "affects":
                entry["affects"] = [a.strip() for a in value.split(",") if a.strip()]
        entries.append(entry)
    return entries


def active_decisions(entries):
    return [e for e in entries if e["status"] == "active"]


def read(path):
    with open(path) as f:
        return f.read()


def exists(feature_dir, name):
    return os.path.exists(os.path.join(feature_dir, name))


# ---------- state ----------

def _last_exported(design_text):
    match = re.search(r"^Last exported:\s*(\d{4}-\d{2}-\d{2})", design_text, re.M)
    return match.group(1) if match else None


def compute_state(feature_dir):
    def result(state, nxt, agent, reason):
        return {"state": state, "next": nxt, "agent": agent, "reason": reason}

    if not exists(feature_dir, "brief.md"):
        return result("start", "begin-design-pr", "repo", "no brief.md")
    if not exists(feature_dir, "REVIEW.md"):
        return result("designing", "begin-pen-session", "pen", "brief.md exists, no REVIEW.md; design, then audit-pen-designs")
    header = parse_front_matter(read(os.path.join(feature_dir, "REVIEW.md")))
    status = header.get("audit_status")
    if status != "clean":
        return result("fixing", "audit-pen-designs", "pen", f"audit_status is {status!r}; fix the canvas and re-run the audit")
    if not exists(feature_dir, "DESIGN.md"):
        return result("ready_for_spec", "finish-design-pr", "repo", "audit clean, no DESIGN.md")
    exported_at = None
    if exists(feature_dir, "pen-nodes.json"):
        with open(os.path.join(feature_dir, "pen-nodes.json")) as f:
            exported_at = json.load(f).get("exportedAt")
    last = _last_exported(read(os.path.join(feature_dir, "DESIGN.md")))
    if exported_at and (last is None or last < exported_at[:10]):
        return result("spec_stale", "finish-design-pr", "repo", f"DESIGN.md Last exported {last} is older than pen-nodes.json exportedAt {exported_at}")
    return result("ready_to_ship", "/ship then /fix-review", "repo", "DESIGN.md is current")


# ---------- cli ----------

def main(argv):
    if len(argv) < 3 or argv[1] not in {"state", "check"}:
        print(__doc__)
        return 2
    feature_dir = os.path.abspath(argv[2])
    if argv[1] == "state":
        s = compute_state(feature_dir)
        for key in ("state", "next", "agent", "reason"):
            print(f"{key.upper()}={s[key]}")
        return 0
    errors = run_checks(feature_dir)
    for e in errors:
        print(f"FAIL: {e}")
    print("OK: all hard checks passed" if not errors else f"{len(errors)} check(s) failed")
    return 1 if errors else 0


def run_checks(feature_dir):
    raise NotImplementedError("added in Task 2")


if __name__ == "__main__":
    sys.exit(main(sys.argv))
