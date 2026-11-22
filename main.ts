// mend: one command-line tool that applies AI-written edits in four formats
// (unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON tool calls) to a
// tree of text files, to the specification SPEC.md ships. Node 22, the standard
// library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer: one line, nothing else. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')
  );
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

/** One file as lines, with its own line break and whether it ends with one. */
interface FileDoc {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function parseFile(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBreak = text.endsWith(br);
  const parts = text.split(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function renderFile(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.finalBreak ? doc.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; nw: string }[] = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  onDisk(p: string): boolean {
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  }

  /** True when the path holds a file in the tree as the edits left it, or a
   *  non-file entry (a directory) sits there on disk. A path an earlier edit
   *  deleted does not count, even though it is still on disk. */
  present(p: string): boolean {
    if (this.get(p) !== null) return true;
    if (this.now.has(p)) return false;
    return this.onDisk(p);
  }
}

type Edit = (tree: Tree) => void;

/** Detect the patch format (SPEC.md section 4), or null when none holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Matching lines (SPEC.md section 5)
// ---------------------------------------------------------------------------

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every 0-based position where pat occurs in lines at one tier, at or after from. */
function occurrences(lines: string[], pat: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (pat.length === 0) return out;
  for (let i = from; i + pat.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < pat.length; k++) {
      if (!lineEq(lines[i + k]!, pat[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which pat occurs. */
function findAtTier(
  lines: string[],
  pat: string[],
  from: number,
  strict: boolean,
): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(lines, pat, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One body line of a hunk or chunk: context, old, new, or a backslash line.
 *  `empty` marks a line that was empty in the patch (a context line whose
 *  text is empty but which came from a non-empty patch line has no mark). */
type BodyItem = { kind: 'ctx' | 'old' | 'new' | 'backslash'; text: string; empty?: boolean };

const oldOf = (items: BodyItem[]): string[] =>
  items.filter((i) => i.kind === 'ctx' || i.kind === 'old').map((i) => i.text);
const newOf = (items: BodyItem[]): string[] =>
  items.filter((i) => i.kind === 'ctx' || i.kind === 'new').map((i) => i.text);

/**
 * The lines that replace a matched block: context lines are the file's own
 * matched lines, never the patch's; at tier 2 every other line of N is
 * re-indented from the old block's leading whitespace to the file's.
 */
function buildReplacement(
  fileLines: string[],
  at: number,
  items: BodyItem[],
  tier: number,
): string[] {
  const out: string[] = [];
  const o = oldOf(items);
  const f = tier === 2 && o.length > 0 ? leadingWs(fileLines[at]!) : '';
  const p = tier === 2 && o.length > 0 ? leadingWs(o[0]!) : '';
  let oIdx = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      out.push(fileLines[at + oIdx]!);
      oIdx++;
    } else if (it.kind === 'old') {
      oIdx++;
    } else if (it.kind === 'new') {
      let t = it.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) {
        t = f + t.slice(p.length);
      }
      out.push(t);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.present(p)) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (
    o.command === 'str_replace' &&
    typeof o.old_str === 'string' &&
    o.old_str !== '' &&
    (o.new_str === undefined || typeof o.new_str === 'string')
  ) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (
    o.command === 'insert' &&
    typeof o.insert_line === 'number' &&
    Number.isInteger(o.insert_line) &&
    typeof o.new_str === 'string'
  ) {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const doc = parseFile(before);
      if (line < 0 || line > doc.lines.length) throw new Fail('no-match', p);
      const lines = [...doc.lines.slice(0, line), ...add, ...doc.lines.slice(line)];
      tree.now.set(p, renderFile({ lines, br: doc.br, finalBreak: doc.finalBreak }));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  items: BodyItem[];
}

interface UnifiedSection {
  /** Old path, or null for /dev/null, or undefined when no --- line named one. */
  oldPath: string | null | undefined;
  /** New path, or null for /dev/null, or undefined when no +++ line named one. */
  newPath: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string;
  diffNew: string;
  create: boolean;
  remove: boolean;
  hunks: Hunk[];
}

/** A ---/+++ path: up to the first tab, surrounding spaces removed, /dev/null
 *  means no file, a leading a/ or b/ removed. */
function stripDiffPath(raw: string): string | null {
  let p = raw.split('\t')[0]!.replace(/^ +| +$/g, '');
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  if (p === '/dev/null') return null;
  return p;
}

function hunkHeaderA(l: string): number | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
  return m ? Number(m[1]) : null;
}

/** Whether a backslash line follows the hunk's last context or + line. */
function hunkNoFinal(h: Hunk): boolean {
  let last = -1;
  h.items.forEach((it, idx) => {
    if (it.kind === 'ctx' || it.kind === 'new') last = idx;
  });
  if (last < 0) return false;
  return h.items[last + 1]?.kind === 'backslash';
}

/** Apply one hunk to a file doc; d is the line drift of this section's hunks
 *  applied so far. Throws Fail('no-match') when the old lines are not found. */
function applyHunk(doc: FileDoc, h: Hunk, d: number, strict: boolean, path: string): FileDoc {
  const o = oldOf(h.items);
  const n = newOf(h.items);
  const lines = doc.lines;
  if (o.length > 0) {
    const found = findAtTier(lines, o, 0, strict);
    if (!found) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    for (const p of found.occ) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const repl = buildReplacement(lines, best, h.items, found.tier);
    const out = [...lines.slice(0, best), ...repl, ...lines.slice(best + o.length)];
    const finalBreak =
      best + o.length === lines.length
        ? hunkNoFinal(h)
          ? false
          : doc.finalBreak
        : doc.finalBreak;
    return { lines: out, br: doc.br, finalBreak };
  }
  const at = Math.min(h.a + d, lines.length);
  const out = [...lines.slice(0, at), ...n, ...lines.slice(at)];
  const finalBreak =
    at === lines.length ? (hunkNoFinal(h) ? false : doc.finalBreak) : doc.finalBreak;
  return { lines: out, br: doc.br, finalBreak };
}

function makeUnifiedEdit(sec: UnifiedSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath !== undefined ? sec.oldPath : (sec.renameFrom ?? sec.diffOld);
    const newP = sec.newPath !== undefined ? sec.newPath : (sec.renameTo ?? sec.diffNew);
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && newP !== oldP && !safe(newP)) throw new Fail('unsafe', newP);
    const isCreate = oldP === null || sec.create;
    if (isCreate) {
      if (newP === null) throw new Fail('unsafe', '/dev/null');
      if (tree.present(newP)) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const it of h.items) if (it.kind === 'new') plus.push(it.text);
      }
      let lastPlus: { h: Hunk; idx: number } | null = null;
      sec.hunks.forEach((h) =>
        h.items.forEach((it, idx) => {
          if (it.kind === 'new') lastPlus = { h, idx };
        }),
      );
      const noFinal =
        lastPlus !== null && lastPlus.h.items[lastPlus.idx + 1]?.kind === 'backslash';
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noFinal ? '' : '\n'));
      return;
    }
    const isDelete = newP === null || sec.remove;
    if (isDelete) {
      if (oldP === null) throw new Fail('missing', '/dev/null');
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP === null) throw new Fail('missing', '/dev/null');
    const cur = tree.get(oldP);
    if (cur === null) throw new Fail('missing', oldP);
    const isMove = newP !== null && newP !== oldP;
    if (isMove && tree.present(newP!)) throw new Fail('exists', newP!);
    let doc = parseFile(cur);
    let d = 0;
    for (const h of sec.hunks) {
      doc = applyHunk(doc, h, d, strict, oldP);
      d += newOf(h.items).length - oldOf(h.items).length;
    }
    const text = renderFile(doc);
    if (isMove) {
      tree.now.set(oldP, null);
      tree.now.set(newP!, text);
      tree.moves.push({ old: oldP, nw: newP! });
    } else {
      tree.now.set(oldP, text);
    }
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  const n = lines.length;
  let sec: UnifiedSection | null = null;
  let inHeader = false;
  let i = 0;
  const sectionStartAt = (j: number): boolean =>
    lines[j]!.startsWith('diff --git ') ||
    (lines[j]!.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ '));
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      sec = {
        oldPath: undefined,
        newPath: undefined,
        renameFrom: null,
        renameTo: null,
        diffOld: m[1]!,
        diffNew: m[2]!,
        create: false,
        remove: false,
        hunks: [],
      };
      sections.push(sec);
      inHeader = true;
      i++;
      continue;
    }
    if (sec !== null && inHeader && l.startsWith('--- ')) {
      if (!(lines[i + 1] ?? '').startsWith('+++ ')) {
        throw new Exit2(`error: parse ${i + 2}`);
      }
      sec.oldPath = stripDiffPath(l.slice(4));
      sec.newPath = stripDiffPath(lines[i + 1]!.slice(4));
      i += 2;
      continue;
    }
    if (sec !== null && inHeader && l.startsWith('+++ ')) {
      sec.newPath = stripDiffPath(l.slice(4));
      i++;
      continue;
    }
    if (sec !== null && inHeader && l.startsWith('rename from ')) {
      sec.renameFrom = l.slice(12).trim();
      i++;
      continue;
    }
    if (sec !== null && inHeader && l.startsWith('rename to ')) {
      sec.renameTo = l.slice(10).trim();
      i++;
      continue;
    }
    if (sec !== null && inHeader && l.startsWith('new file mode')) {
      sec.create = true;
      i++;
      continue;
    }
    if (sec !== null && inHeader && l.startsWith('deleted file mode')) {
      sec.remove = true;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = hunkHeaderA(l);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const items: BodyItem[] = [];
      i++;
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith('@@')) break;
        if (b === '') {
          items.push({ kind: 'ctx', text: '', empty: true });
          i++;
          continue;
        }
        if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          if (b.startsWith('\\')) items.push({ kind: 'backslash', text: b });
          else
            items.push({
              kind: b[0] === ' ' ? 'ctx' : b[0] === '-' ? 'old' : 'new',
              text: b.slice(1),
            });
          i++;
          continue;
        }
        break;
      }
      // Empty lines at the end of a body are not part of it.
      while (items.length > 0) {
        const last = items[items.length - 1]!;
        if (last.kind === 'ctx' && last.empty === true) items.pop();
        else break;
      }
      sec.hunks.push({ a, items });
      continue;
    }
    if (sectionStartAt(i)) {
      sec = {
        oldPath: undefined,
        newPath: undefined,
        renameFrom: null,
        renameTo: null,
        diffOld: '',
        diffNew: '',
        create: false,
        remove: false,
        hunks: [],
      };
      sections.push(sec);
      inHeader = true;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => makeUnifiedEdit(s, strict));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function makeSearchReplaceEdit(
  path: string,
  oldLines: string[],
  newLines: string[],
  strict: boolean,
): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.present(path)) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const doc = parseFile(cur);
    const items: BodyItem[] = [
      ...oldLines.map((t): BodyItem => ({ kind: 'old' as const, text: t })),
      ...newLines.map((t): BodyItem => ({ kind: 'new' as const, text: t })),
    ];
    const found = findAtTier(doc.lines, oldLines, 0, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const repl = buildReplacement(doc.lines, at, items, found.tier);
    const out = [...doc.lines.slice(0, at), ...repl, ...doc.lines.slice(at + oldLines.length)];
    tree.now.set(path, renderFile({ lines: out, br: doc.br, finalBreak: doc.finalBreak }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let sep = -1;
    for (let j = searchLine + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let end = -1;
    for (let j = sep + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(
      makeSearchReplaceEdit(
        path,
        lines.slice(searchLine + 1, sep),
        lines.slice(sep + 1, end),
        strict,
      ),
    );
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  items: BodyItem[];
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  moveTo: string | null;
  addLines: string[];
  chunks: V4aChunk[];
}

function makeV4aEdit(sec: V4aSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.present(sec.path)) throw new Fail('exists', sec.path);
      tree.now.set(
        sec.path,
        sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n',
      );
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    const cur = tree.get(sec.path);
    if (cur === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null) {
      if (!safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
      if (tree.present(sec.moveTo)) throw new Fail('exists', sec.moveTo);
    }
    let doc = parseFile(cur);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        let found: number | null = null;
        const max = strict ? 0 : 2;
        for (let t = 0; t <= max && found === null; t++) {
          for (let k = cursor; k < doc.lines.length; k++) {
            if (lineEq(doc.lines[k]!, chunk.anchor, t)) {
              found = k;
              break;
            }
          }
        }
        if (found === null) throw new Fail('no-match', sec.path);
        cursor = found + 1;
      }
      const o = oldOf(chunk.items);
      const n = newOf(chunk.items);
      if (o.length > 0) {
        const found = findAtTier(doc.lines, o, cursor, strict);
        if (!found) throw new Fail('no-match', sec.path);
        let occ = found.occ;
        if (chunk.eof) occ = occ.filter((p) => p + o.length === doc.lines.length);
        if (occ.length === 0) throw new Fail('no-match', sec.path);
        const at = occ[0]!;
        const repl = buildReplacement(doc.lines, at, chunk.items, found.tier);
        doc = {
          lines: [...doc.lines.slice(0, at), ...repl, ...doc.lines.slice(at + o.length)],
          br: doc.br,
          finalBreak: doc.finalBreak,
        };
        cursor = at + repl.length;
      } else {
        const at = chunk.eof ? doc.lines.length : cursor;
        doc = {
          lines: [...doc.lines.slice(0, at), ...n, ...doc.lines.slice(at)],
          br: doc.br,
          finalBreak: doc.finalBreak,
        };
        cursor = at + n.length;
      }
    }
    const text = renderFile(doc);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, text);
      tree.moves.push({ old: sec.path, nw: sec.moveTo });
    } else {
      tree.now.set(sec.path, text);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') {
    throw new Exit2(`error: parse ${first + 1}`);
  }
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') {
    throw new Exit2(`error: parse ${lines.length + 1}`);
  }
  const edits: Edit[] = [];
  let i = first + 1;
  const sectionStart = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File:')) return 'add';
    if (l.startsWith('*** Delete File:')) return 'delete';
    if (l.startsWith('*** Update File:')) return 'update';
    return null;
  };
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const kind = sectionStart(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = l.slice(l.indexOf(':') + 1).trim();
    const secLine = i;
    // Collect the section's raw lines, then drop blank lines at its end.
    const raw: { text: string; line: number }[] = [];
    i++;
    while (i < last && sectionStart(lines[i]!) === null) {
      raw.push({ text: lines[i]!, line: i });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const addLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) addLines.push(r.text.slice(1));
        else if (r.text === '') addLines.push('');
        else throw new Exit2(`error: parse ${r.line + 1}`);
      }
      edits.push(
        makeV4aEdit({ kind, path, line: secLine, moveTo: null, addLines, chunks: [] }, strict),
      );
      continue;
    }
    if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.line + 1}`);
      edits.push(
        makeV4aEdit({ kind, path, line: secLine, moveTo: null, addLines: [], chunks: [] }, strict),
      );
      continue;
    }
    // Update: an optional Move to first, then chunks. Blank lines ahead of
    // the Move to are separators, not body lines.
    let moveTo: string | null = null;
    let j = 0;
    while (j < raw.length && blank(raw[j]!.text)) j++;
    if (j < raw.length && raw[j]!.text.startsWith('*** Move to:')) {
      moveTo = raw[j]!.text.slice('*** Move to:'.length).trim();
      j++;
    } else {
      j = 0;
    }
    const chunks: V4aChunk[] = [];
    let cur: V4aChunk | null = null;
    let firstChunk = true;
    for (; j < raw.length; j++) {
      const r = raw[j]!;
      const t = r.text;
      if (t.startsWith('@@')) {
        if (cur !== null) chunks.push(cur);
        cur = { anchor: t.slice(2).trim() === '' ? null : t.slice(2).trim(), items: [], eof: false };
        firstChunk = false;
        continue;
      }
      if (t === '*** End of File') {
        if (cur === null) throw new Exit2(`error: parse ${r.line + 1}`);
        cur.eof = true;
        chunks.push(cur);
        cur = null;
        firstChunk = false;
        continue;
      }
      if (t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
        if (cur === null) {
          if (!firstChunk) throw new Exit2(`error: parse ${r.line + 1}`);
          cur = { anchor: null, items: [], eof: false };
          firstChunk = false;
        }
        if (t === '') cur.items.push({ kind: 'ctx', text: '' });
        else
          cur.items.push({
            kind: t[0] === ' ' ? 'ctx' : t[0] === '-' ? 'old' : 'new',
            text: t.slice(1),
          });
        continue;
      }
      throw new Exit2(`error: parse ${r.line + 1}`);
    }
    if (cur !== null) chunks.push(cur);
    if (chunks.length === 0 && moveTo === null) {
      throw new Exit2(`error: parse ${secLine + 1}`);
    }
    edits.push(
      makeV4aEdit({ kind, path, line: secLine, moveTo, addLines: [], chunks }, strict),
    );
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// Running the CLI (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) {
        format = a.slice(9);
      } else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`,
      ],
    };
  }
  // Rows in byte order of the paths (UTF-8); a move prints one R line that
  // replaces its D and A pair and sorts by the new path.
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const m of tree.moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.now.get(m.old);
    const wasNew = tree.original(m.nw);
    const nowNew = tree.now.get(m.nw);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.nw, line: `R ${m.old} -> ${m.nw}` });
      covered.add(m.old);
      covered.add(m.nw);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  // A move's paths are written by the same loop: their old path is deleted
  // and their new path written, so write them here when they were covered.
  for (const m of tree.moves) {
    if (!covered.has(m.old) && !covered.has(m.nw)) continue;
    if (check) continue;
    rmSync(m.old, { force: true });
    mkdirSync(dirname(m.nw), { recursive: true });
    writeFileSync(m.nw, tree.now.get(m.nw)!);
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
