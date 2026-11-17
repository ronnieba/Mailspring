/**
 * Opt-in real selected-single-message summary.
 *
 * Requires a developer build with `--dev --real-selected-summary` (never
 * `--demo`). Isolation is Mailspring-dev — the same userData as `--dev`, not
 * the official `/Applications/Mailspring.app` profile. `--demo` always wins
 * when both flags are present so synthetic fixtures stay the default.
 *
 * Tests may override via `setRealSelectedSummaryOverride`.
 */
let override: boolean | null = null;

export function setRealSelectedSummaryOverride(value: boolean | null): void {
  override = value;
}

export function isRealSelectedSummaryMode(): boolean {
  if (override !== null) {
    return override;
  }
  if (typeof window !== 'undefined') {
    const props = (
      window as unknown as { loadSettings?: { windowProps?: { realSelectedSummary?: boolean } } }
    ).loadSettings?.windowProps;
    if (props && props.realSelectedSummary === true) {
      return true;
    }
  }
  if (typeof process !== 'undefined' && Array.isArray(process.argv)) {
    if (process.argv.includes('--demo') || process.env.MAILSPRING_DEMO === '1') {
      return false;
    }
    if (process.argv.includes('--real-selected-summary')) {
      return true;
    }
  }
  if (typeof process !== 'undefined' && process.env.MAILSPRING_REAL_SELECTED_SUMMARY === '1') {
    return true;
  }
  return false;
}
