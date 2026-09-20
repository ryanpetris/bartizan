"""Lists tmux, screen and Herdr sessions on a host and prints them as one JSON document.

Runs under the login shell that Bartizan opens for discovery, so every backend is queried over a
single channel. Each backend is isolated: one that is missing contributes nothing, and one that
fails contributes a message under "errors" while the others still report their sessions. Detail
queries are best effort and are abandoned as the budget runs out, leaving the sessions themselves.
"""

import json
import os
import re
import shlex
import shutil
import subprocess
import time

BUDGET = 4.0
# Listing is what the interface needs; each backend gets its own share so a slow one answers only for itself.
LISTING_BUDGET = 3.0
CALL_TIMEOUT = 2.0
# Free text is asked for through the q modifier, which escapes it for a shell: a separator of our own would have to be
# a control character, and tmux rewrites those to underscores under the C locale that keeps its messages predictable.
# The modifier arrived in tmux 2.9, so older versions could not be read without guessing at their session names.
TMUX_MINIMUM = (2, 9)
TMUX_FIELDS = ["#{session_id}", "#{session_attached}", "#{session_windows}", "#{session_activity}", "#{q:session_path}", "#{q:session_name}"]
TMUX_FORMAT = " ".join(TMUX_FIELDS)
SCREEN_ROW = re.compile(r"^\s*(\d+\.\S+)\s+.*\((Attached|Detached|Multi, attached|Multi, detached)\)\s*$", re.IGNORECASE)
SCREEN_NUMBER = re.compile(r"^\s*\d+\s*\((.*)\)\s*$")
# tmux stays quiet about a server that is simply not running; that is an empty list, not a failure.
TMUX_QUIET = ("no server running", "No such file or directory", "Connection refused")

started = time.monotonic()


def spent():
    return time.monotonic() - started


def run(args, until=None):
    """Runs a command before `until`, returning its status, stdout and stderr, and never raising."""
    left = (started + BUDGET if until is None else until) - time.monotonic()
    if left <= 0:
        return 255, "", "Timed out"
    try:
        done = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                              encoding="utf-8", errors="replace", timeout=min(CALL_TIMEOUT, left))
        return done.returncode, done.stdout, done.stderr
    except Exception as error:
        return 255, "", str(error)


def message(text):
    """The last few meaningful lines of a failure, as the interface shows them."""
    lines = [line.strip() for line in text.replace("\r\n", "\n").split("\n")]
    return "\n".join([line for line in lines if line][-3:])[-1024:]


def shorten(path):
    home = os.environ.get("HOME")
    if home and (path == home or path.startswith(home + "/")):
        return "~" + path[len(home):]
    return path


def number(text):
    return int(text) if text.isdecimal() else None


def tmux_version(until):
    """The version tmux reports as major and minor numbers, or None where it reports none."""
    code, out, _ = run(["tmux", "-V"], until)
    if code != 0:
        return None
    found = re.search(r"(\d+)\.(\d+)", out)
    return (int(found.group(1)), int(found.group(2))) if found else None


def tmux(until):
    version = tmux_version(until)
    if version is not None and version < TMUX_MINIMUM:
        return [], "Version {}.{} is not supported; {}.{} or later is required".format(
            version[0], version[1], TMUX_MINIMUM[0], TMUX_MINIMUM[1])
    code, out, err = run(["tmux", "list-sessions", "-F", TMUX_FORMAT], until)
    if code != 0:
        text = out + err
        if any(quiet in text for quiet in TMUX_QUIET):
            return [], None
        return [], message(text) or "Could not list tmux sessions"
    sessions = []
    for line in out.splitlines():
        try:
            fields = shlex.split(line)
        except ValueError:
            continue
        if len(fields) != 6:
            continue
        identifier, clients, windows, activity, path, name = fields
        sessions.append({"backend": "tmux", "id": identifier, "name": name, "clients": number(clients) or 0,
                         "windows": number(windows), "activity": number(activity), "where": shorten(path)})
    return sessions, None


def screen(until):
    code, out, err = run(["screen", "-ls"], until)
    # screen reports 1 when it lists sessions without attaching to one.
    if code > 1:
        return [], message(out + err) or "Could not list screen sessions"
    sessions = []
    for line in out.splitlines():
        found = SCREEN_ROW.match(line)
        if not found:
            continue
        identifier = found.group(1)
        sessions.append({"backend": "screen", "id": identifier, "name": re.sub(r"^\d+\.", "", identifier),
                         "clients": 1 if "attached" in found.group(2).lower() else 0})
    return sessions, None


def screen_detail(session):
    """Adds the command in a screen session's current window, which is all it offers beyond its listing."""
    code, out, _ = run(["screen", "-S", session["id"], "-Q", "number"])
    if code != 0:
        return
    found = SCREEN_NUMBER.match(out.strip())
    if found and found.group(1):
        session["doing"] = found.group(1)


def herdr_detail(session):
    """Adds a Herdr session tab count, workspace names and agent state, where its server answers."""
    code, out, _ = run(["herdr", "--session", session["id"], "workspace", "list"])
    if code != 0:
        return
    try:
        spaces = json.loads(out).get("result", {}).get("workspaces")
    except (ValueError, AttributeError):
        return
    if not isinstance(spaces, list):
        return
    tabs, labels, states = 0, [], []
    for space in spaces:
        if not isinstance(space, dict):
            continue
        if isinstance(space.get("tab_count"), int):
            tabs += space["tab_count"]
        if isinstance(space.get("label"), str) and space["label"]:
            labels.append(space["label"])
        if isinstance(space.get("agent_status"), str):
            states.append(space["agent_status"])
    if tabs:
        session["windows"] = tabs
    if labels:
        session["where"] = ", ".join(labels)
    for state in ("working", "idle"):
        if state in states:
            session["doing"] = state
            break


def herdr(until):
    code, out, err = run(["herdr", "session", "list", "--json"], until)
    if code != 0:
        return [], message(out + err) or "Could not list Herdr sessions"
    if not out.strip():
        return [], None
    try:
        listed = json.loads(out)
    except ValueError:
        return [], "Invalid Herdr session listing"
    entries = listed.get("sessions") if isinstance(listed, dict) else None
    if not isinstance(entries, list):
        return [], "Invalid Herdr session listing"
    sessions = []
    for entry in entries:
        if not isinstance(entry, dict) or entry.get("running") is not True:
            continue
        name = entry.get("name")
        if not isinstance(name, str):
            continue
        sessions.append({"backend": "herdr", "id": name, "name": name, "clients": 0})
    return sessions, None


def main():
    sessions, errors = [], {}
    listings = (("tmux", tmux), ("screen", screen), ("herdr", herdr))
    for index, (backend, listing) in enumerate(listings):
        if not shutil.which(backend):
            continue
        try:
            found, failure = listing(started + LISTING_BUDGET * (index + 1) / len(listings))
        except Exception as error:
            found, failure = [], str(error)
        sessions.extend(found)
        if failure:
            errors[backend] = failure
    # Detail is best effort and runs only once every backend has been listed, so a slow one cannot
    # spend the budget a later backend needs to report its sessions at all.
    detail = {"screen": screen_detail, "herdr": herdr_detail}
    for session in sessions:
        if spent() >= BUDGET:
            break
        try:
            detail.get(session["backend"], lambda _: None)(session)
        except Exception:
            pass
    print(json.dumps({"sessions": sessions, "errors": errors}, ensure_ascii=True))


main()
