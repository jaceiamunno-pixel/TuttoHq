// tools/check-secret-logs.mjs
//
// Zero-dependency guard against logging credentials.
//
// Lives in tools/ (tracked by default — NOT scripts/, which .gitignore ignores
// and which would let this security guard silently vanish on a fresh clone or a
// re-add without `git add -f`). A guard that survives by convention is the same
// failure class as the diagnostic it exists to prevent, so it must be enforced,
// not remembered.
//
// Fails when a `console.*` call would emit a SECRET VALUE — a bare identifier
// named like a credential (token / bearer / password / secret / session /
// access_token / apiKey / …), or a `JSON.stringify(...)` / object-spread
// (`{ ...session }`) of one.
//
// Grep-level (no AST), but *string-literal aware*: the text inside '…' / "…"
// literals is stripped before matching, and only the literal text of template
// strings is dropped (the `${…}` interpolations are kept as code). That is the
// whole trick — descriptive prose such as
//   console.log("[gmail-intake] webhook: rejected — bad or missing token")
// does NOT trip, while the line this guard exists to catch,
//   console.log("[apiFetch] bearer json=", JSON.stringify(bearer))
// does.
//
// Escape hatch: put `allow-secret-log` in a comment on the console line (or the
// line directly above it) to intentionally suppress a match. Every use is
// reported by --list-suppressions so a hatch can never hide silently.
//
// Scan scope is src/ + native/ (shipping code that can reach a log stream).
// tools/ is deliberately OUT of scope: the guard does not scan itself (its own
// watch-word list would otherwise self-flag) and other local tooling is not a
// production log surface.
//
// Usage:
//   node tools/check-secret-logs.mjs --all                # full scan of scope
//   node tools/check-secret-logs.mjs --diff <ref>         # only lines added vs <ref>
//   node tools/check-secret-logs.mjs --staged             # only staged added lines
//   node tools/check-secret-logs.mjs --list-suppressions  # print every allow-secret-log use (never fails)
//
// Exit 1 if a violation is found (scan modes); --list-suppressions always exits 0.

import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Identifier-name fragments that mean "credential" when they appear in a *code*
// position inside a console call. Matched case-insensitively as a substring of
// an identifier, so accessToken / refreshToken / sessionToken / apiKey trip too.
const SECRET_WORD =
  /\b\w*(?:token|bearer|password|passwd|secret|session|credential|cookie|authorization|jwt|apikey)\w*\b/i;

const CONSOLE_METHODS = "log|debug|info|warn|error|trace|dir|table|group|groupCollapsed";
const CONSOLE_RE = new RegExp(`console\\s*\\.\\s*(${CONSOLE_METHODS})\\s*\\(`, "g");

// Directories to full-scan. tools/ is intentionally excluded (see header).
const SCAN_DIRS = ["src", "native"];
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const EXCLUDE = [
  /\.(test|spec)\.[cm]?tsx?$/, // test files legitimately assert on secret-ish names
  /(^|[\\/])node_modules[\\/]/,
  /(^|[\\/])(out|\.next|dist|build)[\\/]/,
];

/**
 * Strip the *content* of string literals so credential words hidden in prose do
 * not match, while keeping template `${…}` interpolations as live code.
 */
export function codeOnly(s) {
  let out = "";
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < n) {
        if (s[i] === "\\") { i += 2; continue; }
        if (s[i] === q) { i++; break; }
        i++;
      }
      out += " ";
    } else if (c === "`") {
      i++;
      while (i < n) {
        if (s[i] === "\\") { i += 2; continue; }
        if (s[i] === "`") { i++; break; }
        if (s[i] === "$" && s[i + 1] === "{") {
          i += 2;
          let depth = 1;
          let expr = "";
          while (i < n && depth > 0) {
            const d = s[i];
            if (d === "{") depth++;
            else if (d === "}") { depth--; if (depth === 0) { i++; break; } }
            expr += d;
            i++;
          }
          out += " " + codeOnly(expr) + " "; // recurse: interpolation may nest strings
        } else {
          i++; // drop literal template text
        }
      }
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Walk from the '(' at openIdx to its matching ')', skipping strings, template
// interpolations, and comments so parens inside them do not unbalance the count.
function matchParens(s, openIdx) {
  let i = openIdx;
  let depth = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < n) {
        if (s[i] === "\\") { i += 2; continue; }
        if (s[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === "`") {
      i++;
      while (i < n) {
        if (s[i] === "\\") { i += 2; continue; }
        if (s[i] === "`") { i++; break; }
        if (s[i] === "$" && s[i + 1] === "{") {
          i += 2;
          let bd = 1;
          while (i < n && bd > 0) {
            if (s[i] === "{") bd++;
            else if (s[i] === "}") bd--;
            i++;
          }
        } else i++;
      }
      continue;
    }
    if (c === "/" && s[i + 1] === "/") {
      while (i < n && s[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      i += 2;
      while (i < n && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

// Core scan: returns { violations, suppressed }. A console.* whose args match a
// secret word is a violation unless an allow-secret-log comment covers it, in
// which case it is recorded as suppressed instead.
function scanSource(source, filename) {
  const violations = [];
  const suppressed = [];
  const lines = source.split(/\r?\n/);
  const lineStarts = [0];
  for (let k = 0; k < source.length; k++) if (source[k] === "\n") lineStarts.push(k + 1);
  const offsetToLine = (off) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= off) lo = mid; else hi = mid - 1;
    }
    return lo; // 0-based
  };

  CONSOLE_RE.lastIndex = 0;
  let m;
  while ((m = CONSOLE_RE.exec(source))) {
    const openParen = CONSOLE_RE.lastIndex - 1;
    const closeParen = matchParens(source, openParen);
    if (closeParen === -1) { CONSOLE_RE.lastIndex = openParen + 1; continue; }

    const startLine = offsetToLine(m.index);
    const endLine = offsetToLine(closeParen);
    const args = source.slice(openParen + 1, closeParen);
    const hit = codeOnly(args).match(SECRET_WORD);

    if (hit) {
      const thisLine = lines[startLine] ?? "";
      const prevLine = startLine > 0 ? (lines[startLine - 1] ?? "") : "";
      const isSuppressed = /allow-secret-log/.test(thisLine) || /allow-secret-log/.test(prevLine);
      const entry = {
        file: filename,
        line: startLine + 1,
        endLine: endLine + 1,
        method: m[1],
        matched: hit[0].trim(),
        snippet: thisLine.trim().slice(0, 200),
      };
      (isSuppressed ? suppressed : violations).push(entry);
    }
    CONSOLE_RE.lastIndex = closeParen + 1;
  }
  return { violations, suppressed };
}

/** Find console.* calls that would log a credential value (unsuppressed). */
export function findSecretLogViolations(source, filename = "<input>") {
  return scanSource(source, filename).violations;
}

/** Find console.* credential logs that are suppressed via allow-secret-log. */
export function findSuppressedSecretLogs(source, filename = "<input>") {
  return scanSource(source, filename).suppressed;
}

/* ───────────────────────────── CLI ───────────────────────────── */

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function listScanFiles() {
  const out = sh(`git ls-files -- ${SCAN_DIRS.join(" ")}`);
  return out.split("\n").filter(Boolean).filter(
    (f) => SOURCE_EXT.test(f) && !EXCLUDE.some((re) => re.test(f)),
  );
}

// Parse `git diff --unified=0` into Map<file, Set<addedLineNo>>.
function addedLinesByFile(diffText) {
  const map = new Map();
  let cur = null;
  let cursor = 0;
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).trim().replace(/^b\//, "");
      cur = p === "/dev/null" ? null : p;
      if (cur && !map.has(cur)) map.set(cur, new Set());
    } else if (line.startsWith("@@")) {
      const mm = /\+(\d+)(?:,\d+)?/.exec(line);
      cursor = mm ? parseInt(mm[1], 10) : 0;
    } else if (cur && line.startsWith("+") && !line.startsWith("+++")) {
      map.get(cur).add(cursor);
      cursor++;
    } else if (cur && !line.startsWith("-") && !line.startsWith("\\")) {
      cursor++; // context line (only appears if unified>0)
    }
  }
  return map;
}

function scanDiff(diffCmd) {
  const added = addedLinesByFile(sh(diffCmd));
  const violations = [];
  for (const [file, addedSet] of added) {
    if (!SOURCE_EXT.test(file) || EXCLUDE.some((re) => re.test(file))) continue;
    if (!existsSync(file)) continue; // deleted
    const src = readFileSync(file, "utf8");
    for (const v of findSecretLogViolations(src, file)) {
      for (let ln = v.line; ln <= v.endLine; ln++) {
        if (addedSet.has(ln)) { violations.push(v); break; }
      }
    }
  }
  return violations;
}

function scanAll() {
  const violations = [];
  for (const file of listScanFiles()) {
    violations.push(...findSecretLogViolations(readFileSync(file, "utf8"), file));
  }
  return violations;
}

// Full-scope inventory of every allow-secret-log suppression (never fails).
function listSuppressions() {
  const all = [];
  for (const file of listScanFiles()) {
    all.push(...findSuppressedSecretLogs(readFileSync(file, "utf8"), file));
  }
  return all;
}

function report(violations, mode) {
  if (violations.length === 0) {
    console.log(`✓ check-secret-logs (${mode}): no console.* statements log a credential.`);
    return 0;
  }
  console.error(`✗ check-secret-logs (${mode}): ${violations.length} secret-logging console statement(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  console.${v.method}  →  logs "${v.matched}"`);
    console.error(`      ${v.snippet}`);
  }
  console.error(
    `\nRemove the statement (do not mask it). If it is a genuine false positive,\n` +
    `add an "allow-secret-log: <reason>" comment on that line.`,
  );
  return 1;
}

function reportSuppressions(list) {
  if (list.length === 0) {
    console.log("check-secret-logs: no allow-secret-log suppressions in scope.");
    return 0;
  }
  console.log(`check-secret-logs: ${list.length} allow-secret-log suppression(s) in scope — review that each is still justified:\n`);
  for (const s of list) {
    console.log(`  ${s.file}:${s.line}  console.${s.method}  (allows "${s.matched}")`);
    console.log(`      ${s.snippet}`);
  }
  return 0; // visibility only, never a failure
}

function main(argv) {
  const arg = argv[0];
  if (arg === "--list-suppressions") {
    process.exit(reportSuppressions(listSuppressions()));
  }
  let violations, mode;
  if (arg === "--diff") {
    const ref = argv[1] || "origin/master";
    mode = `diff vs ${ref}`;
    violations = scanDiff(`git diff --unified=0 ${ref}...HEAD`);
  } else if (arg === "--staged") {
    mode = "staged";
    violations = scanDiff(`git diff --unified=0 --cached`);
  } else {
    mode = "all";
    violations = scanAll();
  }
  process.exit(report(violations, mode));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main(process.argv.slice(2));
}
