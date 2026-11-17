/**
 * Word-level diff for the Gemini proofreading review: the user accepts or
 * rejects each change separately. Pure and local.
 */

export type DiffOp = { kind: 'equal' | 'delete' | 'insert'; text: string };

export interface ProofChange {
  id: number;
  before: string;
  after: string;
}

/** Lines including their newline, for the coarse fallback diff. */
export function splitLines(text: string): string[] {
  return (text || '').match(/[^\n]*\n|[^\n]+$/g) || [];
}

/** Words, runs of whitespace and single punctuation marks (keeps newlines). */
export function tokenize(text: string): string[] {
  return (text || '').match(/\s+|[\p{L}\p{N}\p{M}'’״׳-]+|[^\s\p{L}\p{N}\p{M}]/gu) || [];
}

/** Edit distance above which the word diff falls back to whole lines. */
export const MAX_WORD_DIFF_EDITS = 600;

/** Myers O(ND) diff on token arrays; null when more than `maxEdits` edits. */
export function diffTokens(a: string[], b: string[], maxEdits = Infinity): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxEdits);
  const v = new Map<number, number>();
  v.set(1, 0);
  const trace: Map<number, number>[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))) {
        x = v.get(k + 1) ?? 0;
      } else {
        x = (v.get(k - 1) ?? 0) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v.set(k, x);
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  if (!found) {
    return null;
  }
  // Backtrack.
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vv = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && (vv.get(k - 1) ?? -1) < (vv.get(k + 1) ?? -1))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vv.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: 'equal', text: a[x - 1] });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) {
        ops.push({ kind: 'insert', text: b[y - 1] });
      } else {
        ops.push({ kind: 'delete', text: a[x - 1] });
      }
    }
    x = prevX;
    y = prevY;
  }
  ops.reverse();
  // Merge neighbours of the same kind.
  const merged: DiffOp[] = [];
  for (const op of ops) {
    const last = merged[merged.length - 1];
    if (last && last.kind === op.kind) {
      last.text += op.text;
    } else {
      merged.push({ ...op });
    }
  }
  return merged;
}

export type ProofSegment = { kind: 'same'; text: string } | { kind: 'change'; change: ProofChange };

/**
 * Split into unchanged text and numbered changes. A change is a run of
 * deletes/inserts; whitespace-only equal runs between two edits are folded
 * into one change so "a b" → "c d" reads as one suggestion.
 */
export function buildProofSegments(original: string, corrected: string): ProofSegment[] {
  const ops =
    diffTokens(tokenize(original), tokenize(corrected), MAX_WORD_DIFF_EDITS) ||
    // Heavily rewritten text: compare whole lines instead of words.
    (diffTokens(splitLines(original), splitLines(corrected)) as DiffOp[]);
  const segs: ProofSegment[] = [];
  let id = 0;
  let cur: ProofChange | null = null;
  const flush = () => {
    if (cur) {
      segs.push({ kind: 'change', change: cur });
      cur = null;
    }
  };
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.kind === 'equal') {
      const next = ops[i + 1];
      if (cur && /^[ \t]+$/.test(op.text) && next && next.kind !== 'equal') {
        cur.before += op.text;
        cur.after += op.text;
        continue;
      }
      flush();
      segs.push({ kind: 'same', text: op.text });
      continue;
    }
    if (!cur) {
      cur = { id: ++id, before: '', after: '' };
    }
    if (op.kind === 'delete') {
      cur.before += op.text;
    } else {
      cur.after += op.text;
    }
  }
  flush();
  return segs;
}

export function proofChanges(segs: ProofSegment[]): ProofChange[] {
  return segs.filter((s) => s.kind === 'change').map((s) => (s as any).change as ProofChange);
}

/** Rebuild the text: accepted changes use the suggestion, others keep the original. */
export function applyProofDecisions(segs: ProofSegment[], accepted: Set<number>): string {
  return segs
    .map((s) =>
      s.kind === 'same' ? s.text : accepted.has(s.change.id) ? s.change.after : s.change.before
    )
    .join('');
}
