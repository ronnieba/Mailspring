/**
 * Local Gemini usage ledger (offline experiment). Lives in the profile's
 * config dir (never in mail folders). Records only counts: time, model,
 * mode, tokens and an ESTIMATED cost from GEMINI_PRICING_USD_PER_MILLION.
 * No prompts, mail text, ids, or keys are written.
 */
import fs from 'fs';
import path from 'path';
import {
  GEMINI_BUDGET_WARN_RATIO,
  GEMINI_DEFAULT_BUDGET_ILS,
  GEMINI_DEMO_MODEL,
  GEMINI_PRICING_CHECKED,
  GEMINI_PRICING_USD_PER_MILLION,
  GeminiUsageSummary,
  GeminiUsageTotals,
  USD_TO_ILS_ESTIMATE,
} from './gemini-demo-protocol';

export const GEMINI_USAGE_FILE = 'gemini-usage.json';
const MAX_RECORDS = 20000;

export interface GeminiUsageRecord {
  ts: string;
  model: string;
  mode: string;
  input: number;
  output: number;
  total: number;
  usd: number;
  /** Gemini Live sessions only: length in seconds. */
  seconds?: number;
}

export interface GeminiUsageLedgerData {
  version: 1;
  since: string | null;
  budgetIls: number;
  records: GeminiUsageRecord[];
}

export function priceFor(model: string): { input: number; output: number } {
  return GEMINI_PRICING_USD_PER_MILLION[model] || GEMINI_PRICING_USD_PER_MILLION[GEMINI_DEMO_MODEL];
}

/** ESTIMATE. When the split is unknown, all tokens are priced as output (upper bound). */
export function estimateUsd(model: string, input: number, output: number, total: number): number {
  const p = priceFor(model);
  if (input + output === 0 && total > 0) {
    return (total * p.output) / 1e6;
  }
  return (input * p.input + output * p.output) / 1e6;
}

function emptyTotals(): GeminiUsageTotals {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    usd: 0,
    ils: 0,
    liveSessions: 0,
    liveSeconds: 0,
    liveUsd: 0,
  };
}

function add(t: GeminiUsageTotals, r: GeminiUsageRecord) {
  t.calls += 1;
  t.inputTokens += r.input;
  t.outputTokens += r.output;
  t.totalTokens += r.total;
  t.usd += r.usd;
  t.ils = t.usd * USD_TO_ILS_ESTIMATE;
  if (typeof r.seconds === 'number') {
    t.liveSessions = (t.liveSessions || 0) + 1;
    t.liveSeconds = (t.liveSeconds || 0) + r.seconds;
    t.liveUsd = (t.liveUsd || 0) + r.usd;
  }
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function emptyLedger(): GeminiUsageLedgerData {
  return { version: 1, since: null, budgetIls: GEMINI_DEFAULT_BUDGET_ILS, records: [] };
}

export function summarizeLedger(
  data: GeminiUsageLedgerData,
  sessionStart: Date,
  now: Date = new Date()
): GeminiUsageSummary {
  const today = emptyTotals();
  const session = emptyTotals();
  const total = emptyTotals();
  for (const r of data.records) {
    const t = new Date(r.ts);
    add(total, r);
    if (sameLocalDay(t, now)) {
      add(today, r);
    }
    if (t.getTime() >= sessionStart.getTime()) {
      add(session, r);
    }
  }
  const budgetIls = data.budgetIls > 0 ? data.budgetIls : GEMINI_DEFAULT_BUDGET_ILS;
  const ratio = budgetIls > 0 ? total.ils / budgetIls : 0;
  return {
    since: data.since,
    today,
    session,
    total,
    budgetIls,
    budgetUsedRatio: ratio,
    warn: ratio >= GEMINI_BUDGET_WARN_RATIO,
    model: GEMINI_DEMO_MODEL,
    pricing: priceFor(GEMINI_DEMO_MODEL),
    pricingChecked: GEMINI_PRICING_CHECKED,
    usdToIls: USD_TO_ILS_ESTIMATE,
    available: true,
  };
}

export class GeminiUsageLedger {
  readonly file: string;
  readonly sessionStart = new Date();
  private data: GeminiUsageLedgerData | null = null;

  constructor(configDirPath: string) {
    this.file = path.join(configDirPath, GEMINI_USAGE_FILE);
  }

  private load(): GeminiUsageLedgerData {
    if (this.data) {
      return this.data;
    }
    let data = emptyLedger();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && parsed.version === 1 && Array.isArray(parsed.records)) {
        data = {
          version: 1,
          since: typeof parsed.since === 'string' ? parsed.since : null,
          budgetIls:
            typeof parsed.budgetIls === 'number' && parsed.budgetIls > 0
              ? parsed.budgetIls
              : GEMINI_DEFAULT_BUDGET_ILS,
          records: parsed.records.filter(
            (r: any) => r && typeof r.ts === 'string' && typeof r.total === 'number'
          ),
        };
      }
    } catch {
      // missing or unreadable: start empty
    }
    this.data = data;
    return data;
  }

  private save() {
    if (!this.data) {
      return;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
      fs.renameSync(tmp, this.file);
    } catch {
      // Usage display is best-effort; never break a query over it.
    }
  }

  record(
    entry: {
      model?: string;
      mode?: string;
      input: number;
      output: number;
      total: number;
      /** Already priced by modality (Gemini Live); otherwise estimated here. */
      usd?: number;
      seconds?: number;
    },
    now: Date = new Date()
  ): GeminiUsageRecord {
    const data = this.load();
    const model = entry.model || GEMINI_DEMO_MODEL;
    const rec: GeminiUsageRecord = {
      ts: now.toISOString(),
      model,
      mode: entry.mode || 'unknown',
      input: Math.max(0, Math.round(entry.input || 0)),
      output: Math.max(0, Math.round(entry.output || 0)),
      total: Math.max(0, Math.round(entry.total || 0)),
      usd: 0,
    };
    if (!rec.total) {
      rec.total = rec.input + rec.output;
    }
    rec.usd =
      typeof entry.usd === 'number' && Number.isFinite(entry.usd) && entry.usd >= 0
        ? entry.usd
        : estimateUsd(model, rec.input, rec.output, rec.total);
    if (typeof entry.seconds === 'number' && Number.isFinite(entry.seconds)) {
      rec.seconds = Math.max(0, Math.round(entry.seconds * 10) / 10);
    }
    if (!data.since) {
      data.since = rec.ts;
    }
    data.records.push(rec);
    if (data.records.length > MAX_RECORDS) {
      data.records.splice(0, data.records.length - MAX_RECORDS);
    }
    this.save();
    return rec;
  }

  summary(now: Date = new Date()): GeminiUsageSummary {
    return summarizeLedger(this.load(), this.sessionStart, now);
  }

  reset(now: Date = new Date()) {
    const data = this.load();
    data.records = [];
    data.since = now.toISOString();
    this.save();
  }

  setBudget(ils: number) {
    if (!(typeof ils === 'number' && Number.isFinite(ils) && ils > 0 && ils <= 100000)) {
      return false;
    }
    const rounded = Math.round(ils * 10000) / 10000;
    if (rounded <= 0) {
      return false;
    }
    this.load().budgetIls = rounded;
    this.save();
    return true;
  }
}
