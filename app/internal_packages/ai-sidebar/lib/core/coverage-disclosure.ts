import { SearchResult } from './types';
import { tr } from './offline-i18n';

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

  lines.push(tr('**📊 כיסוי ומצב:**', '**📊 Coverage and status:**'));

  if (retrievalMode === 'ranked') {
    lines.push(
      tr(`• מצב: דירוג (top-k) - לא סריקה מלאה`, `• Mode: ranked (top-k) - not a full scan`)
    );
    if (progress.processed !== null) {
      lines.push(
        tr(`• הודעות שעובדו: ${progress.processed}`, `• Messages processed: ${progress.processed}`)
      );
    }
    lines.push(
      tr(
        `⚠️ לא כל ההודעות נסרקו - תוצאות מדורגות בלבד`,
        `⚠️ Not every message was scanned - ranked results only`
      )
    );
  } else {
    lines.push(tr(`• מצב: סריקה מלאה (exhaustive)`, `• Mode: full scan (exhaustive)`));
    if (progress.totalEligible !== null) {
      lines.push(
        tr(
          `• סה"כ בטווח (נסרקו): ${progress.totalEligible}`,
          `• Total in range (scanned): ${progress.totalEligible}`
        )
      );
    } else {
      lines.push(tr(`• סה"כ בטווח: לא ידוע`, `• Total in range: unknown`));
    }
    lines.push(tr(`• עובדו: ${progress.processed}`, `• Processed: ${progress.processed}`));
    if (progress.isComplete) {
      lines.push(tr(`• סריקת הטווח הושלמה`, `• Range scan complete`));
    } else {
      lines.push(tr(`⚠️ סריקה לא הושלמה`, `⚠️ Scan not complete`));
    }
  }

  if (progress.missingBodies > 0) {
    lines.push(
      tr(
        `⚠️ ${progress.missingBodies} הודעות ללא גוף (לא סונכרנו)`,
        `⚠️ ${progress.missingBodies} messages without a body (not synced)`
      )
    );
  }

  if (syncCoverage < 100) {
    lines.push(tr(`• סנכרון: ${syncCoverage.toFixed(0)}%`, `• Sync: ${syncCoverage.toFixed(0)}%`));
  }

  return lines.join('\n');
}
