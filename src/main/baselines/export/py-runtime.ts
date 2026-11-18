// 导出成 lint 时给 Python 项目写的检查脚本（设计 §8 的 script 目标）：check-rules.ts / glob.ts 的 Python 版。
// 和 TS 版逐条对照写；export.test.ts 用同一批样例比对两边的结果（机器上有 python3 时）。
// 前面加上 CHECK = {...}（JSON）就能跑；用户的正则已经在生成时翻成 Python 写法。
export const PY_RUNTIME = String.raw`
import json, os, re, subprocess, sys

MAX_BYTES = 1024 * 1024

def normalize_path(p):
    s = re.sub(r"/{2,}", "/", p.replace("\\", "/"))
    while s.startswith("./"):
        s = s[2:]
    return s.lstrip("/")

def _escape(c):
    return "\\" + c if c in ".+^$()|\\/" else c

def _translate(g):
    out = ""
    i = 0
    braces = 0
    n = len(g)
    while i < n:
        c = g[i]
        if c == "*":
            if i + 1 < n and g[i + 1] == "*":
                at_start = i == 0 or g[i - 1] == "/"
                at_end = i + 2 == n or g[i + 2] == "/"
                if at_start and at_end:
                    if i + 2 == n:
                        out += ".*"
                    else:
                        out += "(?:.*/)?"
                        i += 1
                    i += 2
                    continue
                out += "[^/]*"
                i += 2
                continue
            out += "[^/]*"
        elif c == "?":
            out += "[^/]"
        elif c == "[":
            close = g.find("]", i + 2)
            if close < 0:
                out += "\\["
            else:
                body = g[i + 1:close]
                neg = body.startswith("!") or body.startswith("^")
                if neg:
                    body = body[1:]
                out += "[" + ("^" if neg else "") + body.replace("\\", "\\\\").replace("/", "") + "]"
                i = close
        elif c == "{":
            braces += 1
            out += "(?:"
        elif c == "}" and braces > 0:
            braces -= 1
            out += ")"
        elif c == "," and braces > 0:
            out += "|"
        else:
            out += _escape(c)
        i += 1
    return out + ")" * braces

_glob_cache = {}

def glob_re(pattern):
    if pattern in _glob_cache:
        return _glob_cache[pattern]
    g = normalize_path(pattern.strip())
    if g.endswith("/"):
        g += "**"
    src = "^" + _translate(g) + "$" if "/" in g else "^(?:.*/)?" + _translate(g) + "$"
    try:
        r = re.compile(src)
    except re.error:
        r = re.compile(r"$^")
    _glob_cache[pattern] = r
    return r

def match_any(path, patterns):
    p = normalize_path(path)
    return any(x.strip() and glob_re(x).search(p) for x in patterns)

def in_scope(path, globs, exclude):
    if exclude and match_any(path, exclude):
        return False
    return not globs or match_any(path, globs)

def lines_of(content):
    return re.split(r"\r?\n", content)

def squash(s):
    return re.sub(r"\s+", " ", s.strip())

_rx_cache = {}

def rx_test(pattern, flags, text):
    k = (flags, pattern)
    if k not in _rx_cache:
        try:
            _rx_cache[k] = re.compile(pattern, re.ASCII | (re.IGNORECASE if "i" in flags else 0))
        except re.error:
            _rx_cache[k] = None
    r = _rx_cache[k]
    return bool(r and r.search(text))

def forbidden_pattern(p, content):
    out = []
    if p.get("literal"):
        ci = p.get("flags") == "i"
        needle = p["pattern"].lower() if ci else p["pattern"]
        test = lambda l: needle in (l.lower() if ci else l)
    else:
        flags = "i" if p.get("flags") == "i" else ""
        test = lambda l: rx_test(p["pattern"], flags, l)
    for i, l in enumerate(lines_of(content)):
        if test(l):
            out.append((i + 1, l.strip()[:300]))
    return out

PY_EXT = re.compile(r"\.(py|pyi)$", re.IGNORECASE)
_JS_IMPORTS = [
    re.compile(r"\bfrom\s*[\"']([^\"'\n]+)[\"']", re.ASCII),
    re.compile(r"^\s*import\s*[\"']([^\"'\n]+)[\"']", re.ASCII),
    re.compile(r"\bimport\s*\(\s*[\"']([^\"'\n]+)[\"']\s*\)", re.ASCII),
    re.compile(r"\brequire\s*\(\s*[\"']([^\"'\n]+)[\"']\s*\)", re.ASCII),
]

def imports_of_line(line, python):
    out = []
    if python:
        m = re.match(r"^\s*from\s+(\.*[\w.]*)\s+import\b", line, re.ASCII)
        if m:
            out.append(m.group(1))
        m = re.match(r"^\s*import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*)", line, re.ASCII)
        if m:
            for part in m.group(1).split(","):
                out.append(re.split(r"\s+", part.strip())[0])
        return [x for x in out if x]
    for r in _JS_IMPORTS:
        for m in r.finditer(line):
            if m.group(1) not in out:
                out.append(m.group(1))
    return out

def _join(d, rel):
    parts = d.split("/") if d else []
    for seg in rel.split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            if parts:
                parts.pop()
        else:
            parts.append(seg)
    return "/".join(parts)

def import_targets(spec, file_path, python):
    path = normalize_path(file_path)
    d = path[:path.rfind("/")] if "/" in path else ""
    if python:
        m = re.match(r"^\.+", spec)
        dots = len(m.group(0)) if m else 0
        rest = spec[dots:].replace(".", "/")
        if dots > 0:
            base = d
            for _ in range(1, dots):
                base = base[:base.rfind("/")] if "/" in base else ""
            return [spec, _join(base, rest)]
        return [spec, rest]
    if spec.startswith("./") or spec.startswith("../") or spec in (".", ".."):
        return [spec, _join(d, spec)]
    if spec.startswith("/"):
        return [spec, normalize_path(spec)]
    return [spec]

def import_boundary(p, content, path):
    python = bool(PY_EXT.search(path))
    out = []
    forbid = p.get("forbid") or []
    allow = p.get("allow") or []
    for i, l in enumerate(lines_of(content)):
        for spec in imports_of_line(l, python):
            targets = import_targets(spec, path, python)
            forbidden = any(match_any(t, forbid) for t in targets)
            allowed = len(allow) > 0 and any(match_any(t, allow) for t in targets)
            if forbidden and not allowed:
                out.append((i + 1, spec))
    return out

DEFAULT_KEYWORDS = [
    "temporary", "temporarily", "for now", "not optimal", "suboptimal", "workaround", "hack", "hacky", "quick fix", "TODO", "FIXME", "XXX",
    "暂时", "临时", "先这样", "权宜", "不是最优", "以后再", "待优化", "凑合",
]

C_LIKE = {"line": ["//"], "block": [("/*", "*/")], "template": True}
HASH = {"line": ["#"], "block": [], "template": False}
SYNTAX = [
    (re.compile(r"\.(py|pyi|sh|bash|zsh|rb|ya?ml|toml|pl|r|ps1|cfg|conf|mk|cmake|tf|nix)$|(^|/)(Dockerfile|Makefile|Gemfile|Rakefile)$", re.IGNORECASE), HASH),
    (re.compile(r"\.(sql|lua|hs)$", re.IGNORECASE), {"line": ["--"], "block": [("/*", "*/")], "template": False}),
    (re.compile(r"\.(html?|xml|svg|md|markdown)$", re.IGNORECASE), {"line": [], "block": [("<!--", "-->")], "template": False}),
    (re.compile(r"\.(vue|svelte)$", re.IGNORECASE), {"line": ["//"], "block": [("<!--", "-->"), ("/*", "*/")], "template": True}),
    (re.compile(r"\.(css|scss|less)$", re.IGNORECASE), {"line": ["//"], "block": [("/*", "*/")], "template": False}),
]

def syntax_for(path):
    for r, s in SYNTAX:
        if r.search(path):
            return s
    return C_LIKE

def comments_of(content, path):
    syn = syntax_for(path)
    out = []
    in_block = None
    template = False
    for idx, l in enumerate(lines_of(content)):
        i = 0
        quote = "\x60" if template else None
        buf = ""
        n = len(l)
        while i < n:
            if in_block:
                end = l.find(in_block, i)
                if end < 0:
                    buf += l[i:]
                    i = n
                else:
                    buf += l[i:end]
                    i = end + len(in_block)
                    in_block = None
                    if buf.strip():
                        out.append((idx + 1, buf.strip()))
                    buf = ""
                continue
            c = l[i]
            if quote:
                if c == "\\":
                    i += 2
                else:
                    if c == quote:
                        quote = None
                    i += 1
                continue
            if c in ("\"", "'", "\x60"):
                quote = c
                i += 1
                continue
            block = next((b for b in syn["block"] if l.startswith(b[0], i)), None)
            if block:
                in_block = block[1]
                i += len(block[0])
                continue
            prev = l[i - 1] if i > 0 else ""
            lc = next((s for s in syn["line"] if l.startswith(s, i) and not (s == "//" and prev == ":") and not (s == "#" and prev in ("$", "{"))), None)
            if lc:
                buf += l[i + len(lc):]
                i = n
                continue
            i += 1
        if buf.strip():
            out.append((idx + 1, buf.strip()))
        template = quote == "\x60" and syn["template"]
    return out

CJK = re.compile("[\u3000-\u9fff\uf900-\ufaff]")

def keyword_matcher(keywords):
    en = [k for k in keywords if not CJK.search(k)]
    zh = [k for k in keywords if CJK.search(k)]
    esc = lambda s: re.sub(r"\\\s+", r"\\s+", re.escape(s)) if " " in s else re.escape(s)
    r = re.compile(r"(?<![A-Za-z0-9_])(?:" + "|".join(esc(k) for k in en) + r")(?![A-Za-z0-9_])", re.IGNORECASE | re.ASCII) if en else None
    def has(text):
        if r and r.search(text):
            return True
        return any(k in text for k in zh)
    return has

_TICKET_EXTRA = re.compile(r"(^|[^A-Za-z0-9_&])#\d+\b|https?://\S+", re.ASCII)

def comment_policy(p, content, path, ticket_pattern):
    has = keyword_matcher(p.get("keywords") or DEFAULT_KEYWORDS)
    pattern = p.get("ticketPattern") or ticket_pattern
    out = []
    for line, text in comments_of(content, path):
        if has(text) and not (_TICKET_EXTRA.search(text) or (pattern != "" and rx_test(pattern, "", text))):
            out.append((line, text[:300]))
    return out

def evaluate(check, content, path):
    t = check["type"]
    if t == "forbidden_pattern":
        return forbidden_pattern(check["params"], content)
    if t == "import_boundary":
        return import_boundary(check["params"], content, path)
    if t == "comment_policy":
        return comment_policy(check["params"], content, path, check.get("ticketPattern", ""))
    return []

def git(args, cwd):
    return subprocess.run(["git", "-c", "core.quotepath=off"] + args, cwd=cwd, check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout

def main(argv):
    cwd = os.getcwd()
    try:
        root = git(["rev-parse", "--show-toplevel"], cwd).decode("utf-8").strip() or cwd
    except Exception:
        root = cwd
    all_files = "--all" in argv
    listed = [a for a in argv if a not in ("--all", "--")]
    staged = False
    if listed:
        files = [normalize_path(os.path.relpath(os.path.abspath(f), root)) for f in listed]
    elif all_files:
        files = [f for f in git(["ls-files", "-z"], root).decode("utf-8").split("\0") if f]
    else:
        staged = True
        files = [f for f in git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], root).decode("utf-8").split("\0") if f]
    count = 0
    for f in files:
        if not in_scope(f, CHECK["globs"], CHECK["excludeGlobs"]):
            continue
        try:
            if staged:
                data = git(["show", ":" + f], root)
            else:
                full = os.path.join(root, *f.split("/"))
                if os.path.getsize(full) > MAX_BYTES:
                    continue
                with open(full, "rb") as fh:
                    data = fh.read()
        except Exception:
            continue
        if len(data) > MAX_BYTES or b"\0" in data[:8192]:
            continue
        text = data.decode("utf-8", errors="replace")
        if text.startswith("\ufeff"):
            text = text[1:]
        for line, detail in evaluate(CHECK, text, f):
            count += 1
            d = re.sub(r"\s+", " ", detail)[:200]
            sys.stdout.write("%s:%d: %s%s\n" % (f, line, CHECK["message"] or CHECK["name"], " (" + d + ")" if d else ""))
    if count:
        sys.stderr.write("%s: %d violation%s\n" % (CHECK["name"], count, "" if count == 1 else "s"))
    return 1 if count else 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
`;
