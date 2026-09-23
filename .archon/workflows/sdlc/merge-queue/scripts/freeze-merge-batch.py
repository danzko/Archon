"""Bind the assessor's plan to live GitHub identities before final review."""

import json
import os
import subprocess
import sys
from pathlib import Path


def fail(message: str) -> None:
    print(f"freeze-merge-batch: {message}", file=sys.stderr)
    raise SystemExit(1)


def run_gh(args: list[str]) -> object:
    result = subprocess.run(["gh", *args], capture_output=True, text=True)
    if result.returncode:
        fail(f"GitHub read failed ({result.returncode}).")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        fail("GitHub returned malformed JSON.")


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    if os.environ["INPUTS_READY"] != "true":
        print(json.dumps({"ready": False, "batch": {}, "summary": "assessment is not ready"}))
        return 0
    try:
        plan = json.loads((Path(os.environ["ARTIFACTS_DIR"]) / "merge-plan.json").read_text())
        repository, base, base_sha, entries = (
            plan["repository"], plan["base"], plan["base_sha"], plan["prs"]
        )
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        fail("merge-plan.json is missing or malformed.")
    if (not isinstance(repository, str) or not isinstance(base, str) or not isinstance(base_sha, str)
            or not isinstance(entries, list) or not 1 <= len(entries) <= 5):
        fail("merge plan does not name a bounded repository batch.")
    frozen = []
    seen = set()
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("url"), str):
            fail("merge plan has an invalid PR entry.")
        live = run_gh(["pr", "view", entry["url"], "--repo", repository,
                       "--json", "number,url,headRefOid,baseRefName,state,isDraft,isCrossRepository"])
        if (not isinstance(live, dict) or type(live.get("number")) is not int
                or not all(isinstance(live.get(key), str) for key in ("url", "headRefOid", "baseRefName"))
                or live.get("state") != "OPEN" or live.get("isDraft") is not False
                or live.get("isCrossRepository") is not False or live["baseRefName"] != base):
            fail("a planned PR is no longer an open same-repository candidate.")
        number, head = live["number"], live["headRefOid"]
        if number in seen or entry.get("number") != number or entry.get("head_sha") != head:
            fail("a planned PR identity or head changed before final review.")
        seen.add(number)
        frozen.append({"repository": repository, "number": number, "url": live["url"], "head_sha": head})
    print(json.dumps({"ready": True, "batch": {"repository": repository, "base": base,
          "base_sha": base_sha, "prs": frozen}, "summary": f"froze {len(frozen)} PR(s) for dual review"}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
