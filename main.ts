// main.ts — mend, the CLI SPEC.md specifies (MIT). Node 22, standard library alone.
// Run as `node main.ts [options] [PATCH]`. In a trial the grader runs `node /bot/main.ts`
// with MAKEFUN_ENV_URL set, and this file hands over to runner.ts (last lines below):
// keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer: one line, nothing written. */
class Exit2 {
  line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit that failed: its code and the path it concerns. */
class Fail {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';
const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** A patch's lines: split at \n, one trailing \r removed each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its break (CRLF when its first line feed follows a carriage return), its lines, and whether it ends with a break. An empty file has no lines and no final break. */
interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function renderFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/** Positions where the pattern lines occur in the file lines at one tier (0 exact, 1 trailing trim, 2 both trim). Occurrences may overlap. */
function occurrences(lines: string[], pat: string[], tier: number): number[] {
  const key = tier === 0 ? (s: string): string => s : tier === 1 ? trimEndWs : trimBothWs;
  const pk = pat.map(key);
  const out: number[] = [];
  for (let i = 0; i + pk.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < pk.length; j++) {
      if (key(lines[i + j]!) !== pk[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which the pattern occurs, with its positions. */
function findTier(lines: string[], pat: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, pat, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One new line of a hunk or chunk: its text, whether it is a context line (written as the file's own matched line), its index into O when it is one, and whether a `\` line follows it in the patch body. */
interface NewLine {
  text: string;
  ctx: boolean;
  oi: number;
  nl: boolean;
}

/** Replace the k matched lines at position i with the new lines. Context lines come out as the file's own matched lines; at tier 2 the other lines are re-indented from O's first line to the file's first matched line. */
function spliceLines(lines: string[], i: number, oLen: number, n: NewLine[], tier: number, oFirst: string): string[] {
  const out = lines.slice(0, i);
  if (tier === 2 && oLen > 0) {
    const f = leadWs(lines[i]!);
    const p = leadWs(oFirst);
    for (const nl of n) {
      if (nl.ctx) out.push(lines[i + nl.oi]!);
      else if (nl.text.trim() !== '' && nl.text.startsWith(p)) out.push(f + nl.text.slice(p.length));
      else out.push(nl.text);
    }
  } else {
    for (const nl of n) out.push(nl.ctx ? lines[i + nl.oi]! : nl.text);
  }
  return out.concat(lines.slice(i + oLen));
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk; `moves` records each move edit's (old, new) pair for the R output rows. */
class Tree {
  private orig = new Map<string, string | null>();
  now = new Map<string, string | null>();
  moves: Array<[string, string]> = [];
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
  /** A move edit: the old path leaves, the new path takes the content. */
  move(oldP: string, newP: string, content: string): void {
    this.now.set(oldP, null);
    this.now.set(newP, content);
    this.moves.push([oldP, newP]);
  }
}

type Edit = (tree: Tree) => void;

/** The path of a `--- ` or `+++ ` line: the text after the four characters, up to the first tab, with surrounding spaces removed and a leading a/ or b/ removed. */
function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** One hunk of a unified section. */
interface Hunk {
  a: number;
  o: string[];
  n: NewLine[];
}

/** Collect a hunk's body from `start`, stopping at a line that is not a body line or at a `--- ` line followed by a `+++ ` line. Trailing empty lines are not part of it. */
function collectHunkBody(lines: string[], start: number): { body: string[]; next: number } {
  const body: string[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      body.push(l);
      i++;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { body, next: i };
}

/** A hunk's old lines and new lines from its body. A `\` line marks the context or `+` line it follows. */
function hunkFromBody(body: string[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (let k = 0; k < body.length; k++) {
    const l = body[k]!;
    if (l.startsWith('\\')) continue;
    const nl = body[k + 1] !== undefined && body[k + 1]!.startsWith('\\');
    if (l.startsWith(' ')) {
      o.push(l.slice(1));
      n.push({ text: l.slice(1), ctx: true, oi: o.length - 1, nl });
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1), ctx: false, oi: -1, nl });
    } else {
      // An empty line is a context line with empty text.
      o.push('');
      n.push({ text: '', ctx: true, oi: o.length - 1, nl });
    }
  }
  return { o, n };
}

/** Whether a `\` line follows the hunk's last context or `+` line (the last of its new lines). */
function hunkNoNL(h: Hunk): boolean {
  return h.n.length > 0 && h.n[h.n.length - 1]!.nl;
}

/** Apply a section's hunks to a file's text. The drift d tracks how many lines the earlier hunks added or removed, so each hunk is searched nearest to A-1+d. */
function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const model = parseFile(before);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const at = Math.min(h.a + d, model.lines.length);
      const wasAtEnd = at === model.lines.length;
      const ins = h.n.map((x) => x.text);
      model.lines = model.lines.slice(0, at).concat(ins, model.lines.slice(at));
      if (wasAtEnd && ins.length > 0) model.final = !hunkNoNL(h);
      d += h.n.length;
      continue;
    }
    const found = findTier(model.lines, h.o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    for (const p of found.occ) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const runsToEnd = best + h.o.length === model.lines.length;
    model.lines = spliceLines(model.lines, best, h.o.length, h.n, found.tier, h.o[0]!);
    if (runsToEnd) model.final = !hunkNoNL(h);
    d += h.n.length - h.o.length;
  }
  return renderFile(model);
}

/** One unified section: the paths its header names, its mode flags, and its hunks. */
interface Section {
  pairOld: string | null;
  pairNew: string | null;
  renOld: string | null;
  renNew: string | null;
  gitOld: string | null;
  gitNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function newSection(): Section {
  return {
    pairOld: null,
    pairNew: null,
    renOld: null,
    renNew: null,
    gitOld: null,
    gitNew: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  };
}

/** Parse a unified patch into its sections, then into one edit per section. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const takePair = (s: Section, idx: number): number => {
    s.pairOld = headerPath(lines[idx]!);
    s.pairNew = headerPath(lines[idx + 1]!);
    return idx + 2;
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      sections.push(cur);
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const { body, next } = collectHunkBody(lines, i + 1);
      const { o, n } = hunkFromBody(body);
      cur.hunks.push({ a: Number(m[1]), o, n });
      inHeader = false;
      i = next;
      continue;
    }
    if (cur === null) {
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = newSection();
        sections.push(cur);
        inHeader = true;
        i = takePair(cur, i);
        continue;
      }
      i++;
      continue;
    }
    if (inHeader) {
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (cur.pairOld === null) {
            i = takePair(cur, i);
          } else {
            cur = newSection();
            sections.push(cur);
            inHeader = true;
            i = takePair(cur, i);
          }
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('rename from ')) {
        cur.renOld = l.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renNew = l.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (l === 'new file mode' || l.startsWith('new file mode ')) {
        cur.newFile = true;
        i++;
        continue;
      }
      if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
        cur.deletedFile = true;
        i++;
        continue;
      }
      // Any other header line (index, old mode, new mode, similarity, Index:) is ignored.
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = newSection();
      sections.push(cur);
      inHeader = true;
      i = takePair(cur, i);
      continue;
    }
    // Outside bodies, lines that are not part of a section header are ignored (prose, code fences).
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => sectionEdit(s, strict));
}

/** One unified section as an edit: create, delete, move, or change, with its hunks applied in order. */
function sectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.pairOld ?? sec.renOld ?? sec.gitOld ?? '';
    const newP = sec.pairNew ?? sec.renNew ?? sec.gitNew ?? '';
    const isCreate = oldP === '/dev/null' || sec.newFile;
    const isDelete = newP === '/dev/null' || sec.deletedFile;
    if (isCreate) {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let noNL = false;
      let seenPlus = false;
      for (const h of sec.hunks) {
        for (const x of h.n) {
          if (x.ctx) continue;
          plus.push(x.text);
          seenPlus = true;
          noNL = x.nl;
        }
      }
      const m: FileModel = { br: '\n', lines: plus, final: seenPlus ? !noNL : false };
      tree.now.set(newP, renderFile(m));
      return;
    }
    if (isDelete) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const after = applyHunks(before, sec.hunks, strict, oldP);
      tree.move(oldP, newP, after);
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    const after = applyHunks(before, sec.hunks, strict, oldP);
    if (after !== before) tree.now.set(oldP, after);
  };
}

/** Parse a SEARCH/REPLACE patch into one edit per block. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let eq = -1;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    // The path is the nearest line before the SEARCH line, after the previous block's end,
    // that is not blank and does not start with a fence; otherwise the previous block's path.
    let path: string | null = null;
    for (let j = searchLine - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldL = lines.slice(searchLine + 1, eq);
    const newL = lines.slice(eq + 1, end);
    edits.push(srEdit(path, oldL, newL, strict));
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** One SEARCH/REPLACE block as an edit: an empty old block creates, otherwise the old lines must occur exactly once. */
function srEdit(path: string, oldL: string[], newL: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldL.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      const m: FileModel = { br: '\n', lines: [...newL], final: newL.length > 0 };
      tree.now.set(path, renderFile(m));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = parseFile(before);
    const found = findTier(model.lines, oldL, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const n: NewLine[] = newL.map((t) => ({ text: t, ctx: false, oi: -1, nl: false }));
    const out = spliceLines(model.lines, found.occ[0]!, oldL.length, n, found.tier, oldL[0]!);
    const after = renderFile({ br: model.br, lines: out, final: model.final });
    if (after !== before) tree.now.set(path, after);
  };
}

const V4A_ADD = /^\*\*\* Add File:(?: (.*))?$/;
const V4A_DELETE = /^\*\*\* Delete File:(?: (.*))?$/;
const V4A_UPDATE = /^\*\*\* Update File:(?: (.*))?$/;
const V4A_MOVE = /^\*\*\* Move to:(?: (.*))?$/;

/** Which V4A section a line starts, if any. */
function v4aSectionStart(l: string): 'add' | 'delete' | 'update' | null {
  if (V4A_ADD.test(l)) return 'add';
  if (V4A_DELETE.test(l)) return 'delete';
  if (V4A_UPDATE.test(l)) return 'update';
  return null;
}

/** The path a V4A section-start line names: the rest of the line, its surrounding spaces removed. */
function v4aPathOf(l: string): string {
  const m = /^\*\*\* (?:Add|Delete|Update) File:(?: (.*))?$/.exec(l);
  return (m === null ? '' : m[1] ?? '').trim();
}

/** A V4A section's lines, with their indexes, up to the next section start or the End Patch line. */
function collectV4aSection(lines: string[], start: number, endExclusive: number): { items: Array<{ text: string; idx: number }>; next: number } {
  const items: Array<{ text: string; idx: number }> = [];
  let i = start;
  while (i < endExclusive) {
    if (v4aSectionStart(lines[i]!) !== null) break;
    items.push({ text: lines[i]!, idx: i });
    i++;
  }
  return { items, next: i };
}

/** One chunk of a V4A Update File section: its anchor, its body lines, and whether it runs to the end of the file. */
interface VChunk {
  anchor: string | null;
  body: Array<{ t: string; text: string }>;
  eof: boolean;
}

/** Parse a V4A patch into one edit per section. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const kind = v4aSectionStart(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = v4aPathOf(l);
    const { items, next } = collectV4aSection(lines, i + 1, last);
    const body = [...items];
    while (body.length > 0 && blank(body[body.length - 1]!.text)) body.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const b of body) {
        if (b.text.startsWith('+')) fileLines.push(b.text.slice(1));
        else if (b.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${b.idx + 1}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (kind === 'delete') {
      if (body.length > 0) throw new Exit2(`error: parse ${body[0]!.idx + 1}`);
      edits.push(v4aDeleteEdit(path));
    } else {
      // Update File: an optional `*** Move to: <path>` first line, then chunks.
      let moveTo: string | null = null;
      let rest = body;
      if (body.length > 0 && V4A_MOVE.test(body[0]!.text)) {
        const m = V4A_MOVE.exec(body[0]!.text);
        moveTo = (m === null ? '' : m[1] ?? '').trim();
        rest = body.slice(1);
      }
      const chunks = parseV4aChunks(rest, i + 1);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
    i = next;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** The chunks of a V4A Update File section. A chunk starts at an `@@` line or at its first body line; `*** End of File` closes the chunk it follows. */
function parseV4aChunks(body: Array<{ text: string; idx: number }>, sectionLine: number): VChunk[] {
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  const open = (anchor: string | null): void => {
    cur = { anchor, body: [], eof: false };
    chunks.push(cur);
  };
  for (const b of body) {
    const l = b.text;
    if (l.trimEnd() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${b.idx + 1}`);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (l.startsWith('@@')) {
      open(l.slice(2).trim() === '' ? null : l.slice(2).trim());
      continue;
    }
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) open(null);
      cur!.body.push({ t: l[0]!, text: l.slice(1) });
      continue;
    }
    if (l === '') {
      if (cur === null) open(null);
      cur!.body.push({ t: ' ', text: '' });
      continue;
    }
    throw new Exit2(`error: parse ${b.idx + 1}`);
  }
  return chunks;
}

/** A V4A Add File section as an edit: the file is the section's lines, ended by a line break. */
function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    const m: FileModel = { br: '\n', lines: [...fileLines], final: fileLines.length > 0 };
    tree.now.set(path, renderFile(m));
  };
}

/** A V4A Delete File section as an edit. */
function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/** The first line at or after the cursor equal to the anchor, at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const key = t === 0 ? (s: string): string => s : t === 1 ? trimEndWs : trimBothWs;
    const ak = key(anchor);
    for (let i = cursor; i < lines.length; i++) {
      if (key(lines[i]!) === ak) return i;
    }
  }
  return null;
}

/** A V4A Update File section as an edit: the cursor follows each anchor and each chunk, and a Move to renames the file. */
function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const a = findAnchor(model.lines, ch.anchor, cursor, strict);
        if (a === null) throw new Fail('no-match', path);
        cursor = a + 1;
      }
      const o: string[] = [];
      const n: NewLine[] = [];
      for (const b of ch.body) {
        if (b.t === ' ') {
          o.push(b.text);
          n.push({ text: b.text, ctx: true, oi: o.length - 1, nl: false });
        } else if (b.t === '-') {
          o.push(b.text);
        } else {
          n.push({ text: b.text, ctx: false, oi: -1, nl: false });
        }
      }
      if (o.length === 0) {
        const at = ch.eof ? model.lines.length : cursor;
        const ins = n.map((x) => x.text);
        model.lines = model.lines.slice(0, at).concat(ins, model.lines.slice(at));
        cursor = at + ins.length;
      } else {
        const tiers = strict ? [0] : [0, 1, 2];
        let hit: { tier: number; pos: number } | null = null;
        for (const t of tiers) {
          const occ = occurrences(model.lines, o, t).filter((p) => p >= cursor && (!ch.eof || p + o.length === model.lines.length));
          if (occ.length > 0) {
            hit = { tier: t, pos: occ[0]! };
            break;
          }
        }
        if (hit === null) throw new Fail('no-match', path);
        model.lines = spliceLines(model.lines, hit.pos, o.length, n, hit.tier, o[0]!);
        cursor = hit.pos + n.length;
      }
    }
    const after = renderFile(model);
    if (moveTo !== null) {
      tree.move(path, moveTo, after);
    } else if (after !== before) {
      tree.now.set(path, after);
    }
  };
}

/** One JSON edit object as an edit, or null when it is not a valid edit object. */
function jsonEdit(v: unknown): Edit | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
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
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const model = parseFile(before);
      if (line < 0 || line > model.lines.length) throw new Fail('no-match', p);
      const out = model.lines.slice(0, line).concat(add, model.lines.slice(line));
      const after = out.length === 0 ? '' : out.join(model.br) + (model.final ? model.br : '');
      if (after !== before) tree.now.set(p, after);
    };
  }
  return null;
}

/** Parse a JSON patch into one edit per command: an array, or one object a line with blank lines ignored. In array form any fault is the line where the array starts; in JSON Lines form it is that line. */
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

/** Detect the patch's format from its first lines. */
function detect(lines: string[]): string | null {
  const nonBlank = lines.filter((l) => !blank(l));
  if (nonBlank.length === 0) return null;
  const first = nonBlank[0]!;
  const ft = first.trim();
  if (ft === '*** Begin Patch') return 'v4a';
  const fc = first.trimStart()[0];
  if (fc === '[' || fc === '{') return 'json';
  for (const l of lines) {
    if (l.trimEnd() === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith('diff --git ')) return 'unified';
    if (lines[i]!.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return 'unified';
  }
  return null;
}

/** Run the CLI with the given arguments. Returns the exit code and the lines to print. */
function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const changed: Array<{ p: string; was: string | null; now: string | null }> = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.push({ p, was, now });
  }
  const rows = new Map<string, string>();
  for (const c of changed) {
    if (c.was === null) rows.set(c.p, `A ${c.p}`);
    else if (c.now === null) rows.set(c.p, `D ${c.p}`);
    else rows.set(c.p, `M ${c.p}`);
  }
  for (const [o, n] of tree.moves) {
    const dRow = rows.get(o);
    const aRow = rows.get(n);
    if (dRow !== undefined && dRow.startsWith('D ') && aRow !== undefined && aRow.startsWith('A ')) {
      rows.delete(o);
      rows.delete(n);
      rows.set(n, `R ${o} -> ${n}`);
    }
  }
  const sorted = [...rows.entries()].sort((x, y) => Buffer.compare(Buffer.from(x[0]), Buffer.from(y[0])));
  if (!check) {
    for (const c of changed) {
      if (c.now === null) {
        rmSync(c.p, { force: true });
      } else {
        mkdirSync(dirname(c.p), { recursive: true });
        writeFileSync(c.p, c.now);
      }
    }
  }
  const n = sorted.length;
  return { code: 0, out: [...sorted.map(([, t]) => t), `ok: ${n} ${n === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
