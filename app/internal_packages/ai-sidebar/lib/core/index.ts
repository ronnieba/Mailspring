/**
 * Core module exports - reusable across platforms.
 */
export * from './types';
export { MockAIProvider, mockProvider } from './mock-provider';
export { buildCoverageDisclosure } from './coverage-disclosure';
export {
  LIVE_AI_DISABLED_REASON,
  LIVE_AI_PROVIDERS_ENABLED,
  hostCoverageFooter,
  isAIBoundaryFailure,
  isAIBoundaryOk,
  mockOnlyProviderGuard,
  validateProviderPayload,
} from './ai-boundary';
export { MOCK_AI_WORKER_PATH, mockAiSpawnPlan, runMockAiSubprocess } from './mock-ai-subprocess';
export { filterMessagesByQuery, messageMatchesQuery, queryTokens } from './query-filter';
export {
  abortableDelay,
  demoQueryDelayFromEnv,
  isStaleQueryGeneration,
  nextQueryGeneration,
  parseDemoQueryDelayMs,
  shouldAcceptAssistantResponse,
} from './query-generation';
