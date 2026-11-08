/**
 * Core module exports - reusable across platforms.
 */
export * from './types';
export { MockAIProvider, mockProvider } from './mock-provider';
export { buildCoverageDisclosure } from './coverage-disclosure';
export {
  LIVE_AI_DISABLED_REASON,
  LIVE_AI_PROVIDERS_ENABLED,
  NON_SYNTHETIC_LIVE_REASON,
  hostCoverageFooter,
  isAIBoundaryFailure,
  isAIBoundaryOk,
  mockOnlyProviderGuard,
  validateProviderPayload,
} from './ai-boundary';
export { GeminiDemoProvider } from './gemini-demo-provider';
export {
  formatRealSelectedDisclosure,
  htmlToPlainText,
  isStaleRealSelectedSnapshot,
  prepareRealSelectedBody,
  REAL_SELECTED_QUERY,
  resolveExactSelectedMessage,
} from './real-selected-mail';
export { MOCK_AI_WORKER_PATH, mockAiSpawnPlan, runMockAiSubprocess } from './mock-ai-subprocess';
export {
  filterMessagesByQuery,
  messageMatchesQuery,
  queryRequestsFirstSelectedOnly,
  queryRequestsFullSelectedScan,
  queryTokens,
} from './query-filter';
export {
  abortableDelay,
  demoQueryDelayFromEnv,
  isStaleQueryGeneration,
  nextQueryGeneration,
  parseDemoQueryDelayMs,
  shouldAcceptAssistantResponse,
} from './query-generation';
