#!/usr/bin/env python3
"""
Vercel Sandbox Documentation Updater

Fetches latest docs from https://vercel.com/docs/vercel-sandbox and sub-pages,
compares against local reference files, and reports what changed.

Designed for Claude Code or local terminal (requires internet access to vercel.com).
In claude.ai / Claude Desktop, use web_fetch instead (see SKILL.md).

Usage:
    python3 update_docs.py <references-dir>
    python3 update_docs.py              # defaults to ../references relative to script
"""

import os
import sys
import re
import json
import hashlib
import difflib
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError
from html.parser import HTMLParser

BASE_URL = "https://vercel.com/docs/vercel-sandbox"

KNOWN_URLS = [
    "https://vercel.com/docs/vercel-sandbox",
    "https://vercel.com/docs/vercel-sandbox/quickstart",
    "https://vercel.com/docs/vercel-sandbox/sdk-reference",
    "https://vercel.com/docs/vercel-sandbox/cli-reference",
    "https://vercel.com/docs/vercel-sandbox/pricing",
    "https://vercel.com/docs/vercel-sandbox/examples",
    "https://vercel.com/docs/vercel-sandbox/managing",
]

# Map URLs to which reference file they contribute to
URL_TO_REF = {
    "https://vercel.com/docs/vercel-sandbox": "pricing-and-specs.md",
    "https://vercel.com/docs/vercel-sandbox/quickstart": "quickstart.md",
    "https://vercel.com/docs/vercel-sandbox/sdk-reference": "sdk-reference.md",
    "https://vercel.com/docs/vercel-sandbox/cli-reference": "cli-reference.md",
    "https://vercel.com/docs/vercel-sandbox/pricing": "pricing-and-specs.md",
}


class ContentExtractor(HTMLParser):
    """Extract text from HTML, skipping nav/footer/header/script/style."""

    def __init__(self):
        super().__init__()
        self.chunks = []
        self._skip = {"script", "style", "nav", "footer", "header"}
        self._depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in self._skip:
            self._depth += 1
        if self._depth > 0:
            return
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self.chunks.append(f"\n{'#' * int(tag[1])} ")
        elif tag == "p":
            self.chunks.append("\n\n")
        elif tag == "li":
            self.chunks.append("\n- ")
        elif tag == "br":
            self.chunks.append("\n")
        elif tag == "code":
            self.chunks.append("`")
        elif tag == "pre":
            self.chunks.append("\n```\n")
        elif tag == "tr":
            self.chunks.append("\n| ")
        elif tag in ("td", "th"):
            self.chunks.append(" | ")

    def handle_endtag(self, tag):
        if tag in self._skip and self._depth > 0:
            self._depth -= 1
        if self._depth > 0:
            return
        if tag == "code":
            self.chunks.append("`")
        elif tag == "pre":
            self.chunks.append("\n```\n")

    def handle_data(self, data):
        if self._depth == 0:
            self.chunks.append(data)

    def get_text(self):
        raw = "".join(self.chunks)
        raw = re.sub(r"\n{3,}", "\n\n", raw)
        raw = re.sub(r"[ \t]+", " ", raw)
        return raw.strip()


def fetch_url(url):
    """Fetch URL content as string. Returns None on failure."""
    try:
        req = Request(url, headers={
            "User-Agent": "VercelSandboxSkillUpdater/1.0",
            "Accept": "text/html,application/xhtml+xml",
        })
        with urlopen(req, timeout=30) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except (URLError, HTTPError) as e:
        print(f"  WARNING: Failed to fetch {url}: {e}")
        return None


def extract_content(html):
    """Extract readable text content from HTML."""
    parser = ContentExtractor()
    parser.feed(html)
    return parser.get_text()


def discover_links(html):
    """Find /docs/vercel-sandbox/* links in HTML."""
    matches = re.findall(r'href="(/docs/vercel-sandbox(?:/[^"#]*)?)"', html)
    urls = set()
    for path in matches:
        path = path.rstrip("/")
        if "/reference/" not in path:
            urls.add(f"https://vercel.com{path}")
    return sorted(urls)


def fhash(content):
    return hashlib.sha256(content.encode()).hexdigest()[:16]


def diff_summary(old, new):
    """Return (diff_text, added_count, removed_count)."""
    old_lines = old.splitlines(keepends=True)
    new_lines = new.splitlines(keepends=True)
    diff = list(difflib.unified_diff(old_lines, new_lines, fromfile="previous", tofile="updated", n=2))
    added = sum(1 for l in diff if l.startswith("+") and not l.startswith("+++"))
    removed = sum(1 for l in diff if l.startswith("-") and not l.startswith("---"))
    return "".join(diff), added, removed


def main():
    # Resolve references directory
    if len(sys.argv) > 1:
        ref_dir = Path(sys.argv[1]).resolve()
    else:
        ref_dir = Path(__file__).resolve().parent.parent / "references"

    if not ref_dir.exists():
        print(f"Error: References directory not found: {ref_dir}")
        print(f"Usage: {sys.argv[0]} <references-dir>")
        return 1

    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    print("=" * 64)
    print("  Vercel Sandbox Documentation Updater")
    print(f"  {now_str}")
    print(f"  References: {ref_dir}")
    print("=" * 64)
    print()

    # ── Step 1: Discover pages ──
    print("[1/4] Discovering documentation pages...")
    all_urls = list(KNOWN_URLS)
    main_html = fetch_url(BASE_URL)
    if main_html:
        found = discover_links(main_html)
        new_pages = [u for u in found if u not in all_urls]
        if new_pages:
            print(f"  Found {len(new_pages)} new page(s):")
            for u in new_pages:
                print(f"    + {u}")
                all_urls.append(u)
        else:
            print(f"  No new pages beyond {len(KNOWN_URLS)} known URLs.")
    else:
        print("  Could not fetch main page; using known URLs only.")
    print()

    # ── Step 2: Fetch all pages ──
    print(f"[2/4] Fetching {len(all_urls)} pages...")
    fetched = {}
    for url in all_urls:
        short = url.replace("https://vercel.com/docs/vercel-sandbox", "") or "/"
        html = fetch_url(url)
        if html:
            text = extract_content(html)
            fetched[url] = text
            print(f"  OK  {short} ({len(text):,} chars)")
        else:
            print(f"  FAIL {short}")

    if not fetched:
        print("\nNo pages fetched. Check internet connection.")
        return 1
    print()

    # ── Step 3: Compare and write .fetched.md files ──
    print("[3/4] Comparing with existing reference files...")
    results = []

    for ref_file in sorted(ref_dir.glob("*.md")):
        if ref_file.name.startswith("_"):
            continue

        old_content = ref_file.read_text()

        # Find URLs mapped to this file
        mapped = [u for u, r in URL_TO_REF.items() if r == ref_file.name and u in fetched]
        if not mapped:
            results.append((ref_file.name, "skipped", "no mapped URL fetched", ""))
            continue

        # Build fetched content for this reference
        blocks = []
        for url in mapped:
            blocks.append(f"<!-- Source: {url} -->\n{fetched[url]}")
        new_raw = "\n\n".join(blocks)

        # Write .fetched.md with raw new content for review
        fetched_path = ref_file.with_suffix(".fetched.md")
        fetched_path.write_text(
            f"> Last fetched: {today}\n"
            f"> Sources: {', '.join(mapped)}\n"
            f"> This is raw fetched content. Review and merge into {ref_file.name}.\n\n"
            + new_raw
        )

        # Diff old vs new raw
        diff_text, added, removed = diff_summary(old_content, new_raw)

        # Update the date stamp in the existing file
        updated = re.sub(r"(> Last fetched:) .+", f"\\1 {today}", old_content)
        if updated != old_content:
            ref_file.write_text(updated)

        if added == 0 and removed == 0:
            results.append((ref_file.name, "unchanged", f"hash {fhash(old_content)}", ""))
            # Remove fetched file if no changes
            fetched_path.unlink()
        else:
            detail = f"+{added}/-{removed} lines → review {fetched_path.name}"
            results.append((ref_file.name, "changed", detail, diff_text[:3000]))
            print(f"  CHANGED {ref_file.name}: +{added}/-{removed}")

    print()

    # ── Step 4: Summary ──
    print("[4/4] Summary")
    print("-" * 50)
    print(f"  Pages fetched: {len(fetched)}/{len(all_urls)}")
    print(f"  Reference files: {len(results)}")
    print()

    any_changes = False
    for name, status, detail, diff_text in results:
        icons = {"unchanged": "✓", "changed": "⚡", "skipped": "○"}
        print(f"  {icons[status]} {name}: {status} — {detail}")
        if status == "changed":
            any_changes = True

    print()
    if any_changes:
        print("  Changes detected! .fetched.md files written alongside references.")
        print("  Review them and merge updates into the main reference files.")
        print("  Delete .fetched.md files after merging.")
    else:
        print("  All reference files are up to date. No action needed.")

    # Write metadata
    meta = {
        "last_run": now_str,
        "pages_fetched": len(fetched),
        "pages_attempted": len(all_urls),
        "discovered_urls": all_urls,
        "results": [{"file": n, "status": s, "detail": d} for n, s, d, _ in results],
    }
    (ref_dir / "_update_meta.json").write_text(json.dumps(meta, indent=2))
    print(f"  Metadata: {ref_dir / '_update_meta.json'}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
