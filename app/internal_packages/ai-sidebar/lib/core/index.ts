/**
 * Core module exports - reusable across platforms.
 */
export * from './types';
export { MockAIProvider, mockProvider } from './mock-provider';
export { buildCoverageDisclosure } from './coverage-disclosure';
export { filterMessagesByQuery, messageMatchesQuery, queryTokens } from './query-filter';
export {
  abortableDelay,
  demoQueryDelayFromEnv,
  isStaleQueryGeneration,
  nextQueryGeneration,
  parseDemoQueryDelayMs,
  shouldAcceptAssistantResponse,
} from './query-generation';
