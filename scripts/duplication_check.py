"""Cross-doc content duplication check. GATE-DUPLICATION-1 in docs/DECISIONS.md.

Slides a 15-word window across every tracked markdown file; a window shared by two
files fails the build unless it matches a declared canonical-reuse marker below.
Substring match, not semantic similarity, by design -- see the ledger entry for why.

Every tracked markdown file is covered: docs, skills and their references, core templates and
the repo root. The same file ships to adopted repos as scripts/duplication_check.py (#80), so
no repo keeps a private copy. The commit hook runs it with --staged-only over the staged
markdown files, checking each against the whole tracked tree.

    python3 duplication_check.py [--root DIR] [--staged-only FILE ...]
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

WINDOW = 15  # words; below this, ordinary short phrase overlap is expected and noisy

WORD = re.compile(r"[A-Za-z0-9']+")

# Fenced code blocks are not excluded: a short shared command (a few words) is already
# below WINDOW, and a long duplicated snippet (a whole probe script, a whole gate list)
# is exactly the kind of copy-paste drift this check exists to catch -- excluding code
# fences would blind it to the duplicated probe script that motivated building it.

# Snippets that are deliberate reuse, not drift -- matched as a normalized (lowercase,
# punctuation-stripped) substring of the finding, so one entry covers every file pair
# that shares it, so pairs need no listing. An entry without a real
# reason recreates the blind spot this check exists to close.
DECLARED_MARKERS: dict[str, str] = {
    "dirname readlink claude claude md": (
        "The $OC-resolution snippet (docs/SETUP.md, CLAUDE.md, "
        "skills/olivercode-adoption/SKILL.md). Deliberately identical everywhere it "
        "appears -- SETUP.md itself calls this 'the one hard constraint' and every "
        "doc teaching it should show the exact same pattern so it is recognizable."
    ),
    "optimize do not amputate you are pointing existing rules at a shared home not "
    "deleting them": (
        "docs/SETUP.md's governing rule, restated identically in "
        "skills/olivercode-adoption/SKILL.md because the skill exists to drive that "
        "exact rule during a live session -- see the skill's own 'the rule that "
        "governs everything here' section."
    ),
    "in sessions whose working directory is almost never olivercode so every path in "
    "it must resolve from anywhere": (
        "Same $OC-constraint explanation, SETUP.md and its own driving skill. "
        "Declared alongside the $OC-resolution snippet above for the same reason."
    ),
    "scripts qa probe secret gate sh writes a fake secret commits expects a block": (
        "The one canonical invocation line for scripts/qa/probe-secret-gate.sh "
        "(README.md, docs/SETUP.md, skills/olivercode-adoption/SKILL.md) "
        "-- a runnable example docs/RULES.md wants shown identically "
        "everywhere it appears, not three independently-worded ones."
    ),
    "send this first in one turn exactly as written with no other opening line and no "
    "closing recap": (
        "The fixed instruction that opens every skill's Opening message section "
        "(skill-creation's baseline rule 12). Every skill a person triggers cold carries "
        "the same words, so the agent recognises the section; it is a convention line, "
        "not a rule restated."
    ),
}


def _declared(snippet: str) -> bool:
    return any(marker in snippet for marker in DECLARED_MARKERS)


def _tracked_md(repo_root: Path) -> list[str]:
    out = subprocess.run(
        ["git", "-C", str(repo_root), "ls-files", "*.md"],
        capture_output=True,
        text=True,
        check=False,
    )
    if out.returncode != 0:
        return []
    return [line for line in out.stdout.splitlines() if line.strip()]


def _windows(words: list[str]) -> dict[tuple[str, ...], int]:
    """Map each WINDOW-word tuple to its earliest start index in this file."""
    result: dict[tuple[str, ...], int] = {}
    for i in range(len(words) - WINDOW + 1):
        w = tuple(words[i : i + WINDOW])
        if w not in result:
            result[w] = i
    return result


def _merge_spans(indices: list[int]) -> list[tuple[int, int]]:
    """Collapse overlapping/adjacent window-start indices into (start, end) spans."""
    if not indices:
        return []
    indices = sorted(set(indices))
    spans = []
    start = prev = indices[0]
    for i in indices[1:]:
        if i <= prev + WINDOW:  # overlapping or touching
            prev = i
            continue
        spans.append((start, prev + WINDOW))
        start = prev = i
    spans.append((start, prev + WINDOW))
    return spans


def _read(repo_root: Path, rel: str, staged: set[str] | None) -> str:
    """The text of one file: the staged copy for a file in the commit, else the working copy."""
    if staged is not None and rel in staged:
        out = subprocess.run(
            ["git", "-C", str(repo_root), "show", f":{rel}"],
            capture_output=True, text=True, check=False,
        )
        if out.returncode == 0:
            return out.stdout
    return (repo_root / rel).read_text(encoding="utf-8")


def check_all(repo_root: Path, staged: set[str] | None = None) -> list[str]:
    """Findings across every tracked markdown file. With `staged`, only pairs that include a
    staged file are reported, so a commit is judged on what it adds to the existing tree."""
    failures: list[str] = []

    files = _tracked_md(repo_root)
    # file -> word list, file -> window-hash -> earliest start index
    file_words: dict[str, list[str]] = {}
    file_windows: dict[str, dict[tuple[str, ...], int]] = {}
    for rel in files:
        try:
            text = _read(repo_root, rel, staged)
        except (OSError, UnicodeDecodeError):
            continue
        words = WORD.findall(text.lower())
        file_words[rel] = words
        file_windows[rel] = _windows(words)

    # window -> {file: start_index}, only for windows seen in 2+ files
    window_hits: dict[tuple[str, ...], dict[str, int]] = {}
    for rel, windows in file_windows.items():
        for w, idx in windows.items():
            window_hits.setdefault(w, {})[rel] = idx

    # file-pair -> {file: [start indices of shared windows]}
    pair_starts: dict[frozenset[str], dict[str, list[int]]] = {}
    for w, hits in window_hits.items():
        if len(hits) < 2:
            continue
        rels = sorted(hits)
        for i, a in enumerate(rels):
            for b in rels[i + 1 :]:
                key = frozenset({a, b})
                pair_starts.setdefault(key, {}).setdefault(a, []).append(hits[a])
                pair_starts.setdefault(key, {}).setdefault(b, []).append(hits[b])

    for pair, starts_by_file in sorted(pair_starts.items(), key=lambda kv: sorted(kv[0])):
        a, b = sorted(pair)
        if staged is not None and a not in staged and b not in staged:
            continue
        spans_a = _merge_spans(starts_by_file.get(a, []))
        for start, end in spans_a:
            snippet = " ".join(file_words[a][start:end])
            if _declared(snippet):
                continue
            display = snippet if len(snippet) <= 160 else snippet[:157] + "..."
            failures.append(
                f"duplication: {a} <-> {b}: shared passage ({end - start} words): \"{display}\""
            )

    return failures


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Fail when two tracked markdown files share a passage.")
    parser.add_argument("--root", default=".", help="repo root (default: the current directory)")
    parser.add_argument("--staged-only", nargs="*", metavar="FILE",
                        help="report only passages that involve these files, such as the staged ones")
    args = parser.parse_args(argv)
    staged = None if args.staged_only is None else set(args.staged_only)
    failures = check_all(Path(args.root).resolve(), staged)
    for failure in failures:
        print(failure)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
