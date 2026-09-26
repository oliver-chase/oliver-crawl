#!/usr/bin/env python3
"""Run the vendor asd-ste100 ste-lint.py over markdown with soft-wrapped lines joined.

ste-lint.py splits sentences one physical line at a time, so a paragraph hard-wrapped
at ~95 characters never shows it a sentence longer than one line, and the long-sentence
cap never fires. STE-JOIN-1 in OliverCode's docs/DECISIONS.md.

Joined text goes onto the first line of its block and every consumed line becomes
blank, so reported line numbers still point into the real file. Code fences, headings,
tables, rules, and HTML stay untouched. A list item or a blockquote joins only its own
continuation lines. In YAML frontmatter only indented continuation lines join.

Usage (same arguments as ste-lint.py, linter path first):
    ste-lint-joined.py /path/to/ste-lint.py [--json] [--disable r1,r2] FILE [FILE ...]
    ste-lint-joined.py /path/to/ste-lint.py --selftest
"""
import importlib.util
import re
import sys

FENCE = re.compile(r"^\s*(```|~~~)")
HEADING = re.compile(r"^\s{0,3}#{1,6}(\s|$)")
LIST_ITEM = re.compile(r"^\s*([-*+]|[0-9]+[.)])(\s+|$)")
RULE = re.compile(r"^\s{0,3}([-*_])(\s*\1){2,}\s*$")
HTML = re.compile(r"^\s*<")
QUOTE = re.compile(r"^\s*>\s?")


def load_linter(path):
    spec = importlib.util.spec_from_file_location("ste_lint", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def join_soft_wraps(text, table_lines=frozenset()):
    lines = text.splitlines()
    out = list(lines)
    in_fence = False
    open_at = None  # index in `out` of the block that receives continuation lines
    open_quote = False

    start = 0
    if lines and lines[0].strip() == "---":
        # YAML frontmatter: a folded scalar continues on indented lines.
        end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
        if end is not None:
            key_at = None
            for i in range(1, end):
                if lines[i][:1] in (" ", "\t") and lines[i].strip() and key_at is not None:
                    out[key_at] = out[key_at].rstrip() + " " + lines[i].strip()
                    out[i] = ""
                else:
                    key_at = i
            start = end + 1

    for i in range(start, len(lines)):
        line = lines[i]
        if FENCE.match(line):
            in_fence = not in_fence
            open_at = None
            continue
        if in_fence:
            continue
        stripped = line.strip()
        if (not stripped or i in table_lines or HEADING.match(line)
                or RULE.match(line) or HTML.match(line)):
            open_at = None
            continue

        quote = QUOTE.match(line)
        body = line[quote.end():] if quote else line
        if quote and not body.strip():
            open_at = None  # a bare ">" is a paragraph break inside the quote
            continue
        if LIST_ITEM.match(body) or HEADING.match(body):
            open_at, open_quote = i, bool(quote)
            continue
        # An indented line after a blank line is a code block unless a list is open.
        if open_at is None and not quote and line.startswith("    "):
            continue
        if open_at is not None and (open_quote or not quote):
            out[open_at] = out[open_at].rstrip() + " " + body.strip()
            out[i] = ""
            continue
        open_at, open_quote = i, bool(quote)
    return "\n".join(out) + ("\n" if text.endswith("\n") else "")


def selftest(module):
    def long_count(text):
        findings, _ = module.lint(text)
        return sum(1 for f in findings if f["rule"] == "long-sentence")

    words = [f"word{n}" for n in range(30)]
    wrapped = " ".join(words[:15]) + "\n" + " ".join(words[15:]) + ".\n"
    assert long_count(wrapped) == 0, "vendor linter no longer splits per line"
    joined = join_soft_wraps(wrapped)
    assert long_count(joined) == 1
    # line numbers survive: the finding sits on the paragraph's first line
    findings, _ = module.lint(joined)
    assert [f["line"] for f in findings if f["rule"] == "long-sentence"] == [1]
    assert joined.count("\n") == wrapped.count("\n")

    # list item continuation joins, a new item does not
    text = "- " + " ".join(words[:15]) + "\n  " + " ".join(words[15:]) + ".\n- next item.\n"
    assert long_count(join_soft_wraps(text)) == 1
    text = "- " + " ".join(words[:15]) + ".\n- " + " ".join(words[15:]) + ".\n"
    assert long_count(join_soft_wraps(text)) == 0

    # headings, fences, tables, and blank lines stop a join
    for text in ("# " + " ".join(words[:15]) + "\n" + " ".join(words[15:]) + ".\n",
                 " ".join(words[:15]) + "\n```\n" + " ".join(words[15:]) + "\n```\n",
                 " ".join(words[:15]) + ".\n\n" + " ".join(words[15:]) + ".\n"):
        assert long_count(join_soft_wraps(text)) == 0, text
    table = "| a | b |\n| --- | --- |\n| " + " ".join(words[:15]) + " | x |\n" + " ".join(words[15:]) + "\n"
    lines = table.splitlines()
    assert long_count(join_soft_wraps(table, frozenset(module._markdown_table_cells(lines)))) == 0

    # blockquote continuation joins, a bare ">" breaks it
    quote = "> " + " ".join(words[:15]) + "\n> " + " ".join(words[15:]) + ".\n"
    assert long_count(join_soft_wraps(quote)) == 1
    quote = "> " + " ".join(words[:15]) + ".\n>\n> " + " ".join(words[15:]) + ".\n"
    assert long_count(join_soft_wraps(quote)) == 0

    # frontmatter keys stay separate, a folded value joins
    front = "---\nname: x\ndescription: >\n  " + " ".join(words[:15]) + "\n  " + " ".join(words[15:]) + ".\n---\n"
    assert long_count(join_soft_wraps(front)) == 1
    front = "---\nname: " + " ".join(words[:15]) + "\ndescription: " + " ".join(words[15:]) + ".\n---\n"
    assert long_count(join_soft_wraps(front)) == 0
    print("ste-lint-joined selftest OK")


def main(argv):
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2
    module = load_linter(argv[0])
    args = argv[1:]
    if "--selftest" in args:
        selftest(module)
        return 0
    vendor_lint = module.lint

    def lint(text, filename="<stdin>"):
        tables = frozenset(module._markdown_table_cells(text.splitlines()))
        return vendor_lint(join_soft_wraps(text, tables), filename)

    # ste-lint's main() looks lint up as a module global at call time.
    module.lint = lint
    return module.main(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
