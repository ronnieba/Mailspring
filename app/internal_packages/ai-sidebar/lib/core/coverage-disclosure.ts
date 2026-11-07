import { SearchResult } from './types';

/**
 * Host-calculated coverage footer. Ranked must keep the top-k warning.
 * Exhaustive must not claim ranked, and reports how many in-scope messages
 * were actually scanned (not only how many matched the query).
 * Provider-claimed processed/total counts are ignored; pass SearchResult from
 * the mail adapter, not from an AI payload.
 */
export function buildCoverageDisclosure(searchResult: SearchResult, syncCoverage: number): string {
  const { progress, retrievalMode } = searchResult;
  const lines: string[] = [];

  lines.push('**📊 כיסוי ומצב:**');

  if (retrievalMode === 'ranked') {
    lines.push(`• מצב: דירוג (top-k) - לא סריקה מלאה`);
    if (progress.processed !== null) {
      lines.push(`• הודעות שעובדו: ${progress.processed}`);
    }
    lines.push(`⚠️ לא כל ההודעות נסרקו - תוצאות מדורגות בלבד`);
  } else {
    lines.push(`• מצב: סריקה מלאה (exhaustive)`);
    if (progress.totalEligible !== null) {
      lines.push(`• סה"כ בטווח (נסרקו): ${progress.totalEligible}`);
    } else {
      lines.push(`• סה"כ בטווח: לא ידוע`);
    }
    lines.push(`• עובדו: ${progress.processed}`);
    if (progress.isComplete) {
      lines.push(`• סריקת הטווח הושלמה`);
    } else {
      lines.push(`⚠️ סריקה לא הושלמה`);
    }
  }

  if (progress.missingBodies > 0) {
    lines.push(`⚠️ ${progress.missingBodies} הודעות ללא גוף (לא סונכרנו)`);
  }

  if (syncCoverage < 100) {
    lines.push(`• סנכרון: ${syncCoverage.toFixed(0)}%`);
  }

  return lines.join('\n');
}
