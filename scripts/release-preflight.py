#!/usr/bin/env python3
"""Validate immutable release source without publishing anything."""
import datetime
import json
import os
from pathlib import Path
import re
import subprocess


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


def api(path):
    return json.loads(subprocess.check_output(["gh", "api", path], text=True))


def notes_for(text, version):
    matches = list(re.finditer(r"^## \[?" + re.escape(version) + r"\]? - (\d{4}-\d{2}-\d{2})\s*$", text, re.M))
    if len(matches) != 1:
        raise ValueError("expected exactly one dated changelog section for " + version)
    match = matches[0]
    datetime.date.fromisoformat(match[1])
    notes = re.split(r"^## ", text[match.end():], maxsplit=1, flags=re.M)[0].strip()
    if not notes:
        raise ValueError("release notes are empty")
    return notes + "\n"


def main():
    dry = os.environ.get("DRY_RUN") == "true"
    text = Path("CHANGELOG.md").read_text()
    version = os.environ.get("VERSION", "").removeprefix("v")
    if not version and dry:
        version = json.loads(Path("package.json").read_text())["version"]
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?", version):
        raise ValueError("release version must be SemVer")
    manifest = json.loads(Path("package.json").read_text())
    if manifest["version"] != version or manifest["name"] != os.environ["PACKAGE_NAME"]:
        raise ValueError("package name/version does not match release metadata")
    tag = "v" + version
    head = git("rev-parse", "HEAD")
    repo = os.environ["GITHUB_REPOSITORY"]
    branch = api(f"repos/{repo}/branches/main")
    git("merge-base", "--is-ancestor", head, "origin/main")
    tag_object = ""
    if dry:
        if head != branch["commit"]["sha"]:
            raise ValueError("rehearsal must use the current main commit")
        if os.environ["GITHUB_REF"] != "refs/heads/main":
            raise ValueError("dispatch dry runs from main")
    else:
        if os.environ["GITHUB_EVENT_NAME"] != "push" or os.environ["GITHUB_REF"] != f"refs/tags/{tag}":
            raise ValueError("publish only from a signed version-tag push")
        if git("cat-file", "-t", f"refs/tags/{tag}") != "tag" or git("rev-parse", f"refs/tags/{tag}^{{}}") != head:
            raise ValueError("release tag must be annotated and freeze HEAD")
        tag_object = git("rev-parse", f"refs/tags/{tag}")
        git("-c", "gpg.format=ssh", "-c", "gpg.ssh.allowedSignersFile=.github/release-allowed-signers", "verify-tag", tag)
        releases = api(f"repos/{repo}/releases?per_page=100")
        if any(r["tag_name"] == tag for r in releases):
            raise ValueError("release already exists; never overwrite it")
    for workflow in os.environ["CI_WORKFLOWS"].split(","):
        runs = api(f"repos/{repo}/actions/workflows/{workflow}/runs?head_sha={head}&event=push&per_page=100")["workflow_runs"]
        if not any(r["head_sha"] == head and r["event"] == "push" and r["conclusion"] == "success" for r in runs):
            raise ValueError(f"no green push {workflow} on {head}")
    Path("release-notes.md").write_text(notes_for(text, version))
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        output.write(f"version={version}\ntag={tag}\nsha={head}\ntag_object={tag_object}\n")


if __name__ == "__main__":
    main()
