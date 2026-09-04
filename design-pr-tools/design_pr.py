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
    for a, b, target in overlaps_in(feature_dir):
        print(f"OVERLAP: {a} and {b} both affect {target}; read both")
    errors = run_checks(feature_dir)
    for e in errors:
        print(f"FAIL: {e}")
    print("OK: all hard checks passed" if not errors else f"{len(errors)} check(s) failed")
    return 1 if errors else 0


# ---------- git helpers ----------

def _git(cwd, *args):
    proc = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    return proc.stdout.strip() if proc.returncode == 0 else ""


def repo_root(path):
    return _git(path if os.path.isdir(path) else os.path.dirname(path), "rev-parse", "--show-toplevel")


def _dirty(root, rel):
    return bool(_git(root, "status", "--porcelain", "--", rel))


def _last_commit(root, rel):
    return _git(root, "log", "-1", "--format=%H", "--", rel)


def _is_ancestor(root, older, newer):
    proc = subprocess.run(["git", "merge-base", "--is-ancestor", older, newer], cwd=root, capture_output=True)
    return proc.returncode == 0


def exports_fresh(root, pen_rel, nodes_rel):
    """Exports are fresh when the canvas has not changed since pen-nodes.json was written.

    Dirty canvas + clean exports = stale. Dirty both = same in-flight change, fine.
    Committed: the canvas commit must be an ancestor of (or equal to) the exports commit.
    """
    pen_dirty, nodes_dirty = _dirty(root, pen_rel), _dirty(root, nodes_rel)
    if pen_dirty:
        return nodes_dirty
    pen_commit, nodes_commit = _last_commit(root, pen_rel), _last_commit(root, nodes_rel)
    if not pen_commit:
        return True
    if not nodes_commit:
        return nodes_dirty
    return pen_commit == nodes_commit or _is_ancestor(root, pen_commit, nodes_commit)


# ---------- DESIGN.md parsing ----------

REQUIRED_SECTIONS = [
    "Summary", "User flows", "Design frames", "Existing models", "Model changes", "New models",
    "Data invariants", "Endpoint changes", "Surfaces", "Implementation handoff", "Out of scope",
    "Rejected alternatives", "Open questions",
]

# The iOS DESIGN.md owns flows/frames/surfaces and links the monorepo contract;
# it carries no model or endpoint sections (see design-pr-flow.md "Cross-repo
# features"). Detected by the iOS canvas filename recorded in pen-nodes.json.
IOS_OMITTED_SECTIONS = {
    "Existing models", "Model changes", "New models", "Data invariants", "Endpoint changes",
}


def sections(text):
    """Map '## Heading' -> body text (until the next '## ')."""
    result, current, buf = {}, None, []
    for line in text.splitlines():
        if line.startswith("## "):
            if current is not None:
                result[current] = "\n".join(buf)
            current, buf = line[3:].strip(), []
        elif current is not None:
            buf.append(line)
    if current is not None:
        result[current] = "\n".join(buf)
    return result


def table_rows(body):
    """Yield (header_cells, row_cells) for every markdown table in body."""
    header = None
    for line in body.splitlines():
        if not line.strip().startswith("|"):
            header = None
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if header is None:
            header = cells
        elif all(re.fullmatch(r":?-+:?", c) for c in cells):
            continue
        else:
            yield header, cells


def _ids_in(text):
    return set(re.findall(r"`([A-Za-z0-9]{4,8})`", text))


def design_frames(body):
    frames = []
    for header, cells in table_rows(body):
        if "Node ID" not in header or "PNG" not in header:
            continue
        row = dict(zip(header, cells))
        frames.append({"id": row["Node ID"].strip("`"), "png": row["PNG"].strip("`")})
    return frames


def kinds_in(body):
    for header, cells in table_rows(body):
        if "Kind" in header and "Field" in header:
            row = dict(zip(header, cells))
            yield row.get("Model", ""), row.get("Field", ""), row.get("Kind", "")


def endpoint_bodies(body):
    """Yield (endpoint title, side, raw_json_or_None, said_no_body)."""
    for block in re.split(r"^### ", body, flags=re.M)[1:]:
        title, _, rest = block.partition("\n")
        for side in ("Request", "Response"):
            match = re.search(rf"^{side}:[ \t]*(.*)$", rest, re.M)
            said_no_body = bool(match and "no body" in match.group(1).lower())
            fence = None
            if match and not said_no_body:
                after = rest[match.end():]
                after = re.split(r"^(?:Request|Response):", after, maxsplit=1, flags=re.M)[0]
                fence_match = re.search(r"```json\s*\n(.*?)```", after, re.S)
                fence = fence_match.group(1) if fence_match else None
            yield title.strip(), side, fence, said_no_body


def endpoint_table_rows(body):
    """Yield 'METHOD path' for each row of the Endpoint changes table."""
    for header, cells in table_rows(body):
        if "Method" not in header or "Path" not in header:
            continue
        row = dict(zip(header, cells))
        method, path = row.get("Method", "").strip(), row.get("Path", "").strip()
        if method and path:
            yield f"{method} {path}"


def endpoint_detail_titles(body):
    """The set of '### METHOD path' detail-block headings."""
    return {block.partition("\n")[0].strip()
            for block in re.split(r"^### ", body, flags=re.M)[1:]}


def overlapping_active(entries):
    active = active_decisions(entries)
    overlaps = []
    for i, a in enumerate(active):
        for b in active[i + 1:]:
            for target in a["affects"]:
                if target in b["affects"]:
                    overlaps.append((a["id"], b["id"], target))
    return overlaps


def overlaps_in(feature_dir):
    path = os.path.join(feature_dir, "decisions.md")
    if not os.path.exists(path):
        return []
    return overlapping_active(parse_decisions(read(path)))


# ---------- hard checks ----------

def run_checks(feature_dir):
    errors = []
    root = repo_root(feature_dir)

    review_path = os.path.join(feature_dir, "REVIEW.md")
    if not os.path.exists(review_path):
        return ["REVIEW.md missing; run audit-pen-designs in Pen first"]
    header = parse_front_matter(read(review_path))
    if header.get("audit_status") != "clean":
        errors.append(f"REVIEW.md audit_status is {header.get('audit_status')!r}, must be clean")
    if header.get("tradeoffs_open", 1) != 0:
        errors.append(f"REVIEW.md tradeoffs_open is {header.get('tradeoffs_open')!r}, must be 0")
    if header.get("blocking_findings", 1) != 0:
        errors.append(f"REVIEW.md blocking_findings is {header.get('blocking_findings')!r}, must be 0")

    decisions_path = os.path.join(feature_dir, "decisions.md")
    if os.path.exists(decisions_path):
        entries = parse_decisions(read(decisions_path))
        by_id = {e["id"]: e for e in entries}
        for e in entries:
            target = e["supersedes"]
            if target and target in by_id and by_id[target]["status"] != "superseded":
                errors.append(f"decisions.md: {target} is superseded by {e['id']} but still marked active")

    nodes_path = os.path.join(feature_dir, "pen-nodes.json")
    design_path = os.path.join(feature_dir, "DESIGN.md")
    if not os.path.exists(nodes_path):
        errors.append("pen-nodes.json missing; run export-pen-designs in Pen")
    if not os.path.exists(design_path):
        errors.append("DESIGN.md missing")
    if errors and (not os.path.exists(nodes_path) or not os.path.exists(design_path)):
        return errors

    with open(nodes_path) as f:
        nodes = json.load(f)
    node_ids = {f["id"] for f in nodes.get("frames", [])}
    pen_rel = nodes.get("penFile", "design/playola.pen")
    nodes_rel = os.path.relpath(os.path.realpath(nodes_path), root) if root else ""
    if root and not exports_fresh(root, pen_rel, nodes_rel):
        errors.append(f"exports are stale: {pen_rel} changed after pen-nodes.json was written; run export-pen-designs")

    text = read(design_path)
    secs = sections(text)
    ios = os.path.basename(pen_rel).startswith("playola-ios")
    required = [s for s in REQUIRED_SECTIONS if not (ios and s in IOS_OMITTED_SECTIONS)]
    for name in required:
        if name not in secs:
            errors.append(f"DESIGN.md: missing section '{name}'")
        elif name != "Open questions" and not secs[name].strip():
            errors.append(f"DESIGN.md: section '{name}' is empty")

    for token in ("TBD", "TODO"):
        if re.search(rf"\b{token}\b", text):
            errors.append(f"DESIGN.md: contains placeholder '{token}'")

    open_q = "\n".join(l for l in secs.get("Open questions", "").splitlines()
                       if l.strip() and not l.strip().startswith("(must be empty"))
    if open_q.strip():
        errors.append("DESIGN.md: 'Open questions' must be empty before the design PR is opened")

    frames = design_frames(secs.get("Design frames", ""))
    out_of_scope_ids = _ids_in(secs.get("Out of scope", ""))
    for frame in frames:
        if frame["id"] not in node_ids:
            errors.append(f"DESIGN.md frame {frame['id']} is not in pen-nodes.json")
        if not os.path.exists(os.path.join(feature_dir, frame["png"])):
            errors.append(f"DESIGN.md frame {frame['id']}: PNG {frame['png']} not found on disk")
    design_ids = {f["id"] for f in frames}
    for node_id in sorted(node_ids - design_ids - out_of_scope_ids):
        errors.append(f"pen-nodes.json frame {node_id} is neither in 'Design frames' nor listed under 'Out of scope'")

    for section in ("Model changes", "New models"):
        for model, field, kind in kinds_in(secs.get(section, "")):
            if kind not in KINDS:
                errors.append(f"DESIGN.md {section}: {model}.{field} Kind '{kind}' is not one of {sorted(KINDS)}")

    endpoint_body = secs.get("Endpoint changes", "")
    detail_titles = endpoint_detail_titles(endpoint_body)
    for row in endpoint_table_rows(endpoint_body):
        if row not in detail_titles:
            errors.append(f"DESIGN.md Endpoint changes: table lists '{row}' but has no '### {row}' detail block")

    for title, side, fence, said_no_body in endpoint_bodies(endpoint_body):
        if said_no_body:
            continue
        if fence is None:
            errors.append(f"DESIGN.md endpoint {title}: {side} has no ```json body (write 'no body' if intentional)")
            continue
        try:
            parsed = json.loads(fence)
        except json.JSONDecodeError as exc:
            errors.append(f"DESIGN.md endpoint {title}: {side} JSON does not parse ({exc.msg})")
            continue
        if parsed in ({}, []):
            errors.append(f"DESIGN.md endpoint {title}: {side} body is empty (write 'no body' if intentional)")

    return errors


if __name__ == "__main__":
    sys.exit(main(sys.argv))
