#!/usr/bin/env python3
"""Generates src/transpiler/builtins/signatures.ts: one table of the built-in functions' signatures.

Source: the oracle, PyneCore (PyneSys/pynecore, Apache-2.0), whose library is certified against
TradingView and whose functions take Pine's own parameter names (its compiler emits Pine keyword
arguments unchanged). Each public function of src/pynecore/lib is read with Python's ast: parameter
names in order, which ones have a default (optional), a `*args` (variadic), and the annotations as
written. Nothing is typed in by hand here, and nothing is taken from memory of the Pine reference.

    python3 scripts/gen-builtin-signatures.py <pynecore checkout> [--check]

--check exits 1 when the committed table differs from what the checkout gives (CI: drift).

What the table is not: parameters whose name starts with an underscore are PyneCore's own plumbing
and are left out; a function taking **kwargs has an open shape (`open: true`) and no count can be
checked against it; the annotation text is Python's, kept for the type work that follows, and is
not a Pine type yet.
"""
from __future__ import annotations

import ast
import json
import subprocess
import sys
from pathlib import Path

# A PyneCore module name that is not the Pine namespace's name.
NAMESPACE = {"string": "str", "__init__": ""}
# A PyneCore function name that is not Pine's (Python reserved words and builtins).
RENAMED = {
    ("array", "from_items"): "from",
    ("", "is_na"): "na",
}


def pine_name(namespace: str, func: str) -> str:
    name = RENAMED.get((namespace, func), func)
    return f"{namespace}.{name}" if namespace else name


def decorator_names(node: ast.FunctionDef) -> set[str]:
    out = set()
    for d in node.decorator_list:
        target = d.func if isinstance(d, ast.Call) else d
        if isinstance(target, ast.Attribute):
            out.add(target.attr)
        elif isinstance(target, ast.Name):
            out.add(target.id)
    return out


def overload_of(node: ast.FunctionDef) -> dict | None:
    a = node.args
    positional = [*a.posonlyargs, *a.args]
    defaults = [None] * (len(positional) - len(a.defaults)) + list(a.defaults)
    params = []
    for arg, default in zip(positional, defaults):
        if arg.arg.startswith("_"):
            continue
        params.append({"name": arg.arg, "optional": default is not None, "type": ast.unparse(arg.annotation) if arg.annotation else ""})
    for arg, default in zip(a.kwonlyargs, a.kw_defaults):
        if arg.arg.startswith("_"):
            continue
        params.append({"name": arg.arg, "optional": default is not None, "type": ast.unparse(arg.annotation) if arg.annotation else "", "keywordOnly": True})
    out: dict = {"params": params, "returns": ast.unparse(node.returns) if node.returns else ""}
    if a.vararg is not None and not a.vararg.arg.startswith("_"):
        out["variadic"] = a.vararg.arg
    if a.kwarg is not None or (a.vararg is not None and a.vararg.arg.startswith("_")):
        out["open"] = True
    return out


def read_module(path: Path, namespace: str, table: dict) -> None:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in tree.body:
        if not isinstance(node, ast.FunctionDef) or node.name.startswith("_"):
            continue
        # module_property: a namespace variable (syminfo.ticker), not a function.
        if decorator_names(node) & {"module_property"}:
            continue
        name = pine_name(namespace, node.name)
        overload = overload_of(node)
        entries = table.setdefault(name, [])
        key = json.dumps(overload, sort_keys=True)
        if all(json.dumps(e, sort_keys=True) != key for e in entries):
            entries.append(overload)


def build(checkout: Path) -> tuple[dict, str]:
    lib = checkout / "src" / "pynecore" / "lib"
    if not lib.is_dir():
        raise SystemExit(f"no PyneCore library at {lib}")
    table: dict = {}
    for path in sorted(lib.glob("*.py")):
        if path.stem.startswith("_") and path.stem != "__init__":
            continue
        read_module(path, NAMESPACE.get(path.stem, path.stem), table)
    for sub in sorted(p for p in lib.iterdir() if p.is_dir() and (p / "__init__.py").exists()):
        read_module(sub / "__init__.py", sub.name, table)
        for path in sorted(sub.glob("*.py")):
            if not path.stem.startswith("_"):
                read_module(path, f"{sub.name}.{path.stem}", table)
    # A bare (*args, **kwargs) definition beside described overloads is the dispatcher that picks
    # one of them (label.new by point or by x, y): it describes nothing, so it is not an overload.
    for name, overloads in table.items():
        described = [o for o in overloads if o["params"] or not o.get("open")]
        if described and len(described) < len(overloads):
            table[name] = described
    sha = subprocess.run(["git", "-C", str(checkout), "rev-parse", "--short=7", "HEAD"], capture_output=True, text=True).stdout.strip() or "unknown"
    return dict(sorted(table.items())), sha


def render(table: dict, sha: str) -> str:
    lines = [
        "// GENERATED by scripts/gen-builtin-signatures.py — do not edit by hand.",
        f"// Source: the oracle's library, PyneSys/pynecore@{sha} (src/pynecore/lib), read with Python's ast.",
        "// See the generator's header for what this table is and is not.",
        "",
        "export interface BuiltinParam {",
        "  name: string;",
        "  // Has a default in the oracle, so a call may leave it out.",
        "  optional: boolean;",
        "  // The oracle's annotation as written (Python), not a Pine type.",
        "  type: string;",
        "  // Only passable by keyword.",
        "  keywordOnly?: true;",
        "}",
        "",
        "export interface BuiltinOverload {",
        "  params: readonly BuiltinParam[];",
        "  // The name of a `*args` parameter: any number of further positional arguments.",
        "  variadic?: string;",
        "  // Takes arguments this table does not describe (**kwargs): its counts cannot be checked.",
        "  open?: true;",
        "  returns: string;",
        "}",
        "",
        f'export const BUILTIN_SIGNATURES_SOURCE = "PyneSys/pynecore@{sha}";',
        "",
        "export const BUILTIN_SIGNATURES: Readonly<Record<string, readonly BuiltinOverload[]>> = {",
    ]
    for name, overloads in table.items():
        lines.append(f"  {json.dumps(name)}: [")
        for o in overloads:
            params = ", ".join(
                "{ " + ", ".join(
                    [f"name: {json.dumps(p['name'])}", f"optional: {'true' if p['optional'] else 'false'}", f"type: {json.dumps(p['type'])}"]
                    + (["keywordOnly: true"] if p.get("keywordOnly") else [])
                ) + " }"
                for p in o["params"]
            )
            extra = (f", variadic: {json.dumps(o['variadic'])}" if "variadic" in o else "") + (", open: true" if o.get("open") else "")
            lines.append(f"    {{ params: [{params}]{extra}, returns: {json.dumps(o['returns'])} }},")
        lines.append("  ],")
    lines.append("};")
    return "\n".join(lines) + "\n"


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if len(args) != 1:
        raise SystemExit(__doc__)
    table, sha = build(Path(args[0]))
    text = render(table, sha)
    out = Path(__file__).resolve().parent.parent / "src" / "transpiler" / "builtins" / "signatures.ts"
    if "--check" in sys.argv:
        if not out.exists() or out.read_text(encoding="utf-8") != text:
            raise SystemExit(f"{out} is not what {args[0]} gives: run scripts/gen-builtin-signatures.py")
        return
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    print(f"{len(table)} functions, {sum(len(v) for v in table.values())} overloads -> {out}")


if __name__ == "__main__":
    main()
