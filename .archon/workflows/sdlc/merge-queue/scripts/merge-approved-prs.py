"""Fail-closed merge boundary for a frozen, dual-reviewed GitHub batch."""

import json
import os
import subprocess
import sys
from pathlib import Path


def refuse(message: str, merged: list[str] | None = None) -> int:
    result = {"merged": False, "urls": merged or [], "summary": message}
    Path(os.environ["ARTIFACTS_DIR"]).mkdir(parents=True, exist_ok=True)
    (Path(os.environ["ARTIFACTS_DIR"]) / "merge-result.md").write_text(
        "# Merge result\n\n" + result["summary"] + "\n", encoding="utf-8"
    )
    print(json.dumps(result))
    return 0


def input_json(name: str) -> object:
    try:
        return json.loads(os.environ[name])
    except (KeyError, json.JSONDecodeError):
        raise ValueError(f"{name} is not JSON")


def gh_result(args: list[str]) -> subprocess.CompletedProcess[str] | None:
    try:
        return subprocess.run(["gh", *args], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return None


def gh(args: list[str]) -> subprocess.CompletedProcess[str] | None:
    result = gh_result(args)
    if result is None:
        return None
    return result if result.returncode == 0 else None


def gh_json(args: list[str]) -> object | None:
    result = gh(args)
    if result is None:
        return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return None


def batch_entries(batch: object) -> tuple[str, str, str, list[dict]] | None:
    if not isinstance(batch, dict):
        return None
    repository, base, base_sha, prs = (batch.get("repository"), batch.get("base"),
                                        batch.get("base_sha"), batch.get("prs"))
    if (not all(isinstance(value, str) and value for value in (repository, base, base_sha))
            or not isinstance(prs, list) or not 1 <= len(prs) <= 5):
        return None
    seen = set()
    for pr in prs:
        if (not isinstance(pr, dict) or type(pr.get("number")) is not int
                or not all(isinstance(pr.get(key), str) and pr[key]
                           for key in ("repository", "url", "head_sha"))
                or pr["repository"] != repository or pr["number"] in seen):
            return None
        seen.add(pr["number"])
    return repository, base, base_sha, prs


def exact_review(output: object, prs: list[dict]) -> bool:
    if not isinstance(output, dict) or not isinstance(output.get("reviews"), list):
        return False
    expected = {(pr["repository"], pr["number"], pr["head_sha"]) for pr in prs}
    actual = set()
    for review in output["reviews"]:
        if (not isinstance(review, dict) or type(review.get("number")) is not int
                or not all(isinstance(review.get(key), str) for key in ("repository", "head_sha", "action", "findings"))
                or type(review.get("ready")) is not bool or review["ready"] is not True
                or review["action"] != "none"):
            return False
        key = (review["repository"], review["number"], review["head_sha"])
        if key in actual:
            return False
        actual.add(key)
    return actual == expected


def role_name(step_name: object) -> str | None:
    if not isinstance(step_name, str):
        return None
    return step_name.rsplit("__", 1)[-1]


def vendor_matches(role: str, started: dict, completed: dict) -> bool:
    provider, model = started.get("provider"), started.get("model")
    usage = completed.get("model_usage")
    billed = usage.get("resolved") if isinstance(usage, dict) else None
    if not isinstance(provider, str) or not isinstance(model, str):
        return False
    if role == "review-anthropic":
        if provider == "claude":
            # Claude reports its billed model only when the SDK resolved one. Without
            # that native identity, a claimed Anthropic review is ambiguous.
            if not isinstance(usage, dict):
                return False
            requested, resolved = usage.get("requested"), usage.get("resolved")
            return all(isinstance(value, str) and value.startswith("claude-")
                       for value in (model, requested, resolved))
        return (provider == "pi" and model.startswith("anthropic/")
                and (billed is None or isinstance(billed, str) and billed.startswith("anthropic/")))
    return (provider == "pi" and model.startswith(("zai/", "zai-coding-cn/"))
            and (billed is None or isinstance(billed, str)
                 and billed.startswith(("zai/", "zai-coding-cn/"))))


def verified_events(anthropic: object, zai: object) -> bool:
    run_id = os.environ.get("WORKFLOW_ID", "")
    if not run_id or any(char.isspace() or ord(char) < 32 for char in run_id):
        return False
    executable = os.environ.get("ARCHON_EXECUTABLE", "archon")
    try:
        prefix = json.loads(os.environ.get("ARCHON_EXECUTABLE_ARGS", "[]"))
    except json.JSONDecodeError:
        return False
    if not isinstance(prefix, list) or any(not isinstance(item, str) for item in prefix):
        return False
    try:
        result = subprocess.run([executable, *prefix, "workflow", "get", run_id, "--json", "--verbose", "--events"],
                                capture_output=True, text=True, timeout=60)
        payload = json.loads(result.stdout)
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError):
        return False
    if result.returncode != 0 or not isinstance(payload, dict) or payload.get("id") != run_id:
        return False
    events = payload.get("events")
    if not isinstance(events, list):
        return False
    starts: dict[str, list[dict]] = {"review-anthropic": [], "review-zai": []}
    completes: dict[str, list[dict]] = {"review-anthropic": [], "review-zai": []}
    expected = {"review-anthropic": anthropic, "review-zai": zai}
    for event in events:
        if not isinstance(event, dict):
            continue
        role = role_name(event.get("step_name"))
        if role not in starts or not isinstance(event.get("data"), dict):
            continue
        if event.get("event_type") == "node_started" and event["data"].get("command") == "review-merge-candidate":
            starts[role].append(event["data"])
        elif event.get("event_type") == "node_completed":
            completes[role].append(event["data"])
        elif event.get("event_type") in ("node_failed", "node_skipped", "node_skipped_prior_success"):
            return False
    for role in starts:
        # One terminal, current-run command execution per role: replayed/old successes,
        # failures and duplicated starts are intentionally ambiguous and cannot merge.
        if len(starts[role]) != 1 or len(completes[role]) != 1:
            return False
        if completes[role][0].get("structured_output") != expected[role]:
            return False
        if not vendor_matches(role, starts[role][0], completes[role][0]):
            return False
    return True


def current_pr(repository: str, pr: dict) -> dict | None:
    payload = gh_json(["pr", "view", pr["url"], "--repo", repository,
                       "--json", "number,url,headRefOid,baseRefName,state,isDraft,isCrossRepository,mergeStateStatus"])
    if not isinstance(payload, dict):
        return None
    required = (payload.get("number") == pr["number"] and payload.get("url") == pr["url"]
                and payload.get("headRefOid") == pr["head_sha"] and payload.get("state") == "OPEN"
                and payload.get("isDraft") is False and payload.get("isCrossRepository") is False)
    return payload if required else None


def merge_ready_pr(repository: str, pr: dict) -> dict | None:
    pr = current_pr(repository, pr)
    return pr if pr is not None and pr.get("mergeStateStatus") == "CLEAN" else None


def live_base(repository: str, base: str) -> str | None:
    result = gh(["api", f"repos/{repository}/branches/{base}", "--jq", ".commit.sha"])
    sha = result.stdout.strip() if result is not None else ""
    return sha or None


def checks_pass(repository: str, pr: dict) -> bool:
    payload = gh_json(["pr", "checks", pr["url"], "--repo", repository, "--json", "name,bucket"])
    if not isinstance(payload, list) or not payload:
        return False
    names = set()
    for check in payload:
        if not isinstance(check, dict) or not isinstance(check.get("name"), str) or check.get("bucket") != "pass":
            return False
        names.add(check["name"])
    return "factory/runtime" in names and {"factory/review-anthropic", "factory/review-zai"} <= names


def publish_statuses(repository: str, pr: dict) -> bool:
    for context in ("factory/review-anthropic", "factory/review-zai"):
        result = gh(["api", f"repos/{repository}/statuses/{pr['head_sha']}", "-f", "state=success",
                     "-f", f"context={context}", "-f", "description=fresh exact-head review verified by merge gate"])
        if result is None:
            return False
    return True


def authorized(mode: str, approval: str) -> bool:
    if mode == "auto":
        return True
    if mode != "approve":
        return False
    try:
        return isinstance((decision := json.loads(approval)), dict) and decision.get("decision") == "approve"
    except json.JSONDecodeError:
        return False


def main() -> int:
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    try:
        batch = input_json("INPUTS_BATCH")
        anthropic, zai = input_json("INPUTS_ANTHROPIC"), input_json("INPUTS_ZAI")
    except ValueError as error:
        return refuse(f"merge refused: {error}.")
    parsed = batch_entries(batch)
    if parsed is None:
        return refuse("merge refused: frozen batch is malformed.")
    repository, base, expected_base, prs = parsed
    approval = os.environ.get("INPUTS_APPROVAL", "")
    mode = os.environ.get("INPUTS_MODE", "")
    if os.environ.get("INPUTS_READY") != "true" or not authorized(mode, approval):
        return refuse("merge not authorized for this batch.")
    if not exact_review(anthropic, prs) or not exact_review(zai, prs) or not verified_events(anthropic, zai):
        return refuse("merge refused: fresh, distinct vendor review evidence is incomplete.")
    live_base_sha = expected_base
    if live_base(repository, base) != live_base_sha:
        return refuse("merge refused: the live base moved after assessment.")
    merged: list[str] = []
    for pr in prs:
        live = current_pr(repository, pr)
        if live_base(repository, base) != live_base_sha or live is None or live.get("baseRefName") != base:
            return refuse("merge refused: a PR changed after review.", merged)
        if not publish_statuses(repository, pr):
            return refuse("merge refused: verified review statuses could not be published.", merged)
        if merge_ready_pr(repository, pr) is None or not checks_pass(repository, pr):
            return refuse("merge refused: required live checks are not all passing.", merged)
        gh_result(["pr", "merge", pr["url"], "--repo", repository, "--squash",
                   "--match-head-commit", pr["head_sha"]])
        read_back = gh_json(["pr", "view", pr["url"], "--repo", repository, "--json", "state,mergeCommit"])
        if not isinstance(read_back, dict) or read_back.get("state") != "MERGED":
            return refuse("merge stopped: GitHub did not confirm the requested merge.", merged)
        merged.append(pr["url"])
        if len(merged) < len(prs):
            return refuse("merge stopped: the confirmed merge advanced the shared base; revalidate remaining PRs.", merged)
    summary = f"confirmed merge of {len(merged)} PR(s) after fresh Anthropic and Z.AI reviews"
    Path(os.environ["ARTIFACTS_DIR"]).mkdir(parents=True, exist_ok=True)
    (Path(os.environ["ARTIFACTS_DIR"]) / "merge-result.md").write_text("# Merge result\n\n" + summary + "\n")
    print(json.dumps({"merged": True, "urls": merged, "summary": summary}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
