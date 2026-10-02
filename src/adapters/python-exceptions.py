from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path
from typing import Any

SKIP_DIRS = {".git", ".hg", ".svn", ".venv", "venv", "node_modules", "__pycache__", "dist", "build"}


def clip(text: str, limit: int) -> str:
    text = text.strip()
    if len(text) <= limit:
        return text
    if limit <= 3:
        return text[:limit]
    return text[: limit - 3].rstrip() + "..."


def display_path(path: Path) -> str:
    resolved = path.resolve()
    cwd = Path.cwd().resolve()
    try:
        return resolved.relative_to(cwd).as_posix()
    except ValueError:
        return resolved.as_posix()


def iter_python_files(scope: str) -> list[Path]:
    root = Path(scope)
    if root.is_file():
        return [root] if root.suffix == ".py" else []
    if not root.exists():
        raise FileNotFoundError(f"scope does not exist: {scope}")
    files: list[Path] = []
    for path in root.rglob("*.py"):
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        files.append(path)
    return sorted(files, key=lambda p: display_path(p))


def source_for_lines(lines: list[str], start: int | None, end: int | None) -> str:
    if not start or not end or start < 1:
        return ""
    end = min(end, len(lines))
    if end < start:
        return ""
    return "".join(lines[start - 1 : end])


def node_source(lines: list[str], node: ast.AST, limit: int) -> str:
    return clip(source_for_lines(lines, getattr(node, "lineno", None), getattr(node, "end_lineno", None)), limit)


def nodes_source(lines: list[str], nodes: list[ast.AST], limit: int) -> str:
    if not nodes:
        return "<none>"
    start = getattr(nodes[0], "lineno", None)
    end = getattr(nodes[-1], "end_lineno", None)
    text = source_for_lines(lines, start, end)
    return clip(text, limit) if text.strip() else "<none>"


def parse_file(path: Path) -> tuple[str, list[str], ast.AST]:
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)
    tree = ast.parse(text, filename=str(path))
    return text, lines, tree


def build_maps(tree: ast.AST) -> tuple[dict[int, ast.AST], dict[int, tuple[list[ast.stmt], int]]]:
    parents: dict[int, ast.AST] = {}
    stmt_lists: dict[int, tuple[list[ast.stmt], int]] = {}
    for parent in ast.walk(tree):
        for child in ast.iter_child_nodes(parent):
            parents[id(child)] = parent
        for _field, value in ast.iter_fields(parent):
            if isinstance(value, list) and value and all(isinstance(item, ast.stmt) for item in value):
                for index, statement in enumerate(value):
                    stmt_lists[id(statement)] = (value, index)
    return parents, stmt_lists


def ancestors(node: ast.AST, parents: dict[int, ast.AST]):
    current = parents.get(id(node))
    while current is not None:
        yield current
        current = parents.get(id(current))


def scope_names(node: ast.AST, parents: dict[int, ast.AST]) -> list[str]:
    names: list[str] = []
    for current in ancestors(node, parents):
        if isinstance(current, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.append(current.name)
    return list(reversed(names))


def nearest(node: ast.AST, parents: dict[int, ast.AST], kinds: tuple[type[ast.AST], ...]) -> ast.AST | None:
    for current in ancestors(node, parents):
        if isinstance(current, kinds):
            return current
    return None


def caught_text(handler: ast.ExceptHandler) -> str:
    if handler.type is None:
        return "<bare>"
    try:
        return ast.unparse(handler.type)
    except Exception:
        return type(handler.type).__name__


def downstream_nodes(try_node: ast.AST, stmt_lists: dict[int, tuple[list[ast.stmt], int]]):
    entry = stmt_lists.get(id(try_node))
    if not entry:
        return []
    statements, index = entry
    return statements[index + 1 : index + 3]


def candidate_record(path: Path, lines: list[str], handler: ast.ExceptHandler, parents, stmt_lists) -> dict[str, Any]:
    try_node = nearest(handler, parents, (ast.Try, getattr(ast, "TryStar", ast.Try)))
    operation = nodes_source(lines, list(getattr(try_node, "body", [])), 850) if try_node else "<unknown>"
    handler_text = nodes_source(lines, list(handler.body), 800)
    downstream = nodes_source(lines, downstream_nodes(try_node, stmt_lists) if try_node else [], 420)
    scope = ".".join(scope_names(handler, parents)) or "<module>"
    start = getattr(handler, "lineno", 0)
    end = getattr(handler, "end_lineno", start)
    record_id = f"{display_path(path)}:{start}-{end}"
    text = (
        f"scope: {scope}\n"
        f"caught: {caught_text(handler)}\n"
        f"operation: {operation}\n"
        f"handler: {handler_text}\n"
        f"downstream: {downstream}"
    )
    return {"id": record_id, "text": clip(text, 2400)}


def discover(scope: str, include_items: bool) -> dict[str, Any]:
    issues: list[dict[str, str]] = []
    items: list[dict[str, Any]] = []
    total = 0
    files = iter_python_files(scope)
    for path in files:
        try:
            _text, lines, tree = parse_file(path)
        except (OSError, UnicodeDecodeError, SyntaxError) as exc:
            issues.append({"source": display_path(path), "message": f"{type(exc).__name__}: {exc}"})
            continue
        parents, stmt_lists = build_maps(tree)
        handlers = [node for node in ast.walk(tree) if isinstance(node, ast.ExceptHandler)]
        handlers.sort(key=lambda node: (getattr(node, "lineno", 0), getattr(node, "end_lineno", 0)))
        total += len(handlers)
        if include_items:
            items.extend(candidate_record(path, lines, handler, parents, stmt_lists) for handler in handlers)
    if issues:
        result = {"status": "error", "scope": scope, "total": total, "issues": issues[:50]}
        if include_items:
            result["items"] = []
        return result
    result: dict[str, Any] = {"status": "ok", "scope": scope, "total": total}
    if include_items:
        result["items"] = items
    return result


def parse_id(value: str) -> tuple[str, int, int] | None:
    try:
        path_part, range_part = value.rsplit(":", 1)
        start_s, end_s = range_part.split("-", 1)
        return path_part.replace("\\", "/"), int(start_s), int(end_s)
    except Exception:
        return None


def call_name(call: ast.Call) -> str | None:
    func = call.func
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return None


def line_window(lines: list[str], lineno: int, radius: int = 1, limit: int = 320) -> str:
    start = max(1, lineno - radius)
    end = min(len(lines), lineno + radius)
    return clip(source_for_lines(lines, start, end), limit)


def evidence(scope: str, ids: list[str], max_items: int, max_sources: int, max_chars: int) -> dict[str, Any]:
    wanted = []
    invalid: list[dict[str, str]] = []
    for value in ids:
        parsed = parse_id(value)
        if parsed is None:
            invalid.append({"message": f"invalid handler id: {value}"})
        else:
            wanted.append((value, *parsed))
    if invalid:
        return {"status": "error", "scope": scope, "requested": len(ids), "packetIds": [], "sourceCount": 0, "chars": 0, "items": [], "issues": invalid[:50]}

    all_files = iter_python_files(scope)
    path_lookup = {display_path(path): path for path in all_files}

    # Apply deterministic item/source bounds before parsing. Evidence parsing touches only
    # target source files; non-target files are read only for lightweight call-site hints.
    bounded_wanted: list[tuple[str, str, int, int]] = []
    bounded_sources: list[str] = []
    bounded_source_set: set[str] = set()
    for record in wanted:
        if len(bounded_wanted) >= max_items:
            break
        _value, path_name, _start, _end = record
        if path_name not in bounded_source_set:
            if len(bounded_sources) >= max_sources:
                break
            bounded_sources.append(path_name)
            bounded_source_set.add(path_name)
        bounded_wanted.append(record)

    for _value, path_name, _start, _end in bounded_wanted:
        if path_name not in path_lookup:
            return {
                "status": "error",
                "scope": scope,
                "requested": len(ids),
                "packetIds": [],
                "sourceCount": 0,
                "chars": 0,
                "items": [],
                "issues": [{"source": path_name, "message": f"source for review target is unavailable: {_value}"}],
            }

    file_cache: dict[str, tuple[Path, list[str], ast.AST, dict[int, ast.AST], dict[int, tuple[list[ast.stmt], int]]]] = {}
    handlers: dict[tuple[str, int, int], ast.ExceptHandler] = {}
    function_for_handler: dict[tuple[str, int, int], ast.AST | None] = {}

    for shown in bounded_sources:
        path = path_lookup[shown]
        try:
            _text, lines, tree = parse_file(path)
        except (OSError, UnicodeDecodeError, SyntaxError) as exc:
            return {
                "status": "error",
                "scope": scope,
                "requested": len(ids),
                "packetIds": [],
                "sourceCount": 0,
                "chars": 0,
                "items": [],
                "issues": [{"source": shown, "message": f"{type(exc).__name__}: {exc}"}],
            }
        parents, stmt_lists = build_maps(tree)
        file_cache[shown] = (path, lines, tree, parents, stmt_lists)
        for node in ast.walk(tree):
            if isinstance(node, ast.ExceptHandler):
                key = (shown, getattr(node, "lineno", 0), getattr(node, "end_lineno", getattr(node, "lineno", 0)))
                handlers[key] = node
                function_for_handler[key] = nearest(node, parents, (ast.FunctionDef, ast.AsyncFunctionDef))

    # Validate bounded IDs before emitting any evidence and collect function names.
    function_names: set[str] = set()
    for value, path_name, start, end in bounded_wanted:
        key = (path_name, start, end)
        if key not in handlers:
            return {
                "status": "error",
                "scope": scope,
                "requested": len(ids),
                "packetIds": [],
                "sourceCount": 0,
                "chars": 0,
                "items": [],
                "issues": [{"source": path_name, "message": f"stale or unresolved review target: {value}"}],
            }
        function_node = function_for_handler.get(key)
        if isinstance(function_node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            function_names.add(function_node.name)

    # Lightweight caller hints: scan source text once without reparsing every file AST.
    call_index: dict[str, list[tuple[str, int, str]]] = {name: [] for name in function_names}
    if function_names:
        patterns = {name: re.compile(rf"\b{re.escape(name)}\s*\(") for name in function_names}
        for path in all_files:
            shown = display_path(path)
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError) as exc:
                return {
                    "status": "error",
                    "scope": scope,
                    "requested": len(ids),
                    "packetIds": [],
                    "sourceCount": 0,
                    "chars": 0,
                    "items": [],
                    "issues": [{"source": shown, "message": f"{type(exc).__name__}: {exc}"}],
                }
            lines = text.splitlines(keepends=True)
            for lineno, line in enumerate(lines, 1):
                stripped = line.lstrip()
                if stripped.startswith("def ") or stripped.startswith("async def "):
                    continue
                for name, pattern in patterns.items():
                    if pattern.search(line):
                        call_index[name].append((shown, lineno, line_window(lines, lineno)))

    packet: list[dict[str, str]] = []
    packet_ids: list[str] = []
    sources: set[str] = set()
    chars = 0

    for value, path_name, start, end in bounded_wanted:
        key = (path_name, start, end)
        handler = handlers[key]
        _path, lines, _tree, parents, stmt_lists = file_cache[path_name]
        try_node = nearest(handler, parents, (ast.Try, getattr(ast, "TryStar", ast.Try)))
        scope_node = nearest(handler, parents, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
        function_node = function_for_handler.get(key)
        scope_name = ".".join(scope_names(handler, parents)) or "<module>"
        operation = nodes_source(lines, list(getattr(try_node, "body", [])), 420) if try_node else "<unknown>"
        handler_text = nodes_source(lines, list(handler.body), 420)
        downstream = nodes_source(lines, downstream_nodes(try_node, stmt_lists) if try_node else [], 240)
        # Avoid repeating most of the same function body already present in operation/handler/downstream.
        # A compact signature/context line plus caller hints carries the structural context needed for review.
        context = line_window(lines, getattr(scope_node, "lineno", start), 0, 260) if scope_node else line_window(lines, start, 1, 260)
        callers: list[str] = []
        if isinstance(function_node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for caller_path, caller_line, snippet in call_index.get(function_node.name, []):
                if caller_path == path_name and getattr(function_node, "lineno", 0) <= caller_line <= getattr(function_node, "end_lineno", 0):
                    continue
                callers.append(f"{caller_path}:{caller_line}: {clip(snippet, 170)}")
                if len(callers) >= 2:
                    break
        evidence_text = (
            f"id: {value}\n"
            f"scope: {scope_name}\n"
            f"caught: {caught_text(handler)}\n"
            f"operation: {operation}\n"
            f"handler: {handler_text}\n"
            f"downstream: {downstream}\n"
            f"context: {context}\n"
            f"callers: {' | '.join(callers) if callers else '<none found>'}"
        )
        evidence_text = clip(evidence_text, 1800)
        projected = chars + len(evidence_text)
        if packet and projected > max_chars:
            break
        if not packet and len(evidence_text) > max_chars:
            evidence_text = clip(evidence_text, max_chars)
            projected = len(evidence_text)
        packet.append({"id": value, "source": path_name, "evidence": evidence_text})
        packet_ids.append(value)
        sources.add(path_name)
        chars = projected

    return {
        "status": "ok",
        "scope": scope,
        "requested": len(ids),
        "packetIds": packet_ids,
        "sourceCount": len(sources),
        "chars": chars,
        "items": packet,
    }


def main() -> None:
    request = json.load(sys.stdin)
    action = request.get("action")
    scope = str(request.get("scope") or ".")
    if action == "count":
        result = discover(scope, False)
    elif action == "discover":
        result = discover(scope, True)
    elif action == "evidence":
        result = evidence(
            scope,
            [str(value) for value in request.get("ids") or []],
            max(1, min(int(request.get("maxItems") or 80), 500)),
            max(1, min(int(request.get("maxSources") or 10), 100)),
            max(1000, min(int(request.get("maxChars") or 40000), 250000)),
        )
    else:
        result = {"status": "error", "scope": scope, "total": 0, "issues": [{"message": f"unknown action: {action}"}]}
    json.dump(result, sys.stdout, ensure_ascii=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
