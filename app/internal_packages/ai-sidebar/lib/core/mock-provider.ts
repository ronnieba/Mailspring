/**
 * Mock AI provider for development and testing.
 * IMPORTANT: This provider does NOT connect to any AI service.
 * All responses are deterministic fixture-based for testability.
 */
import {
  AIProvider,
  MessageRef,
  ResolvedScope,
  ProcessingBudget,
  SearchProgress,
  Citation,
} from './types';

const MOCK_PROVIDER_NAME = 'Mock AI (No External Connection)';

/**
 * Escape HTML entities to prevent XSS when displaying user content.
 */
function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Deterministic mock responses based on query keywords.
 * These exercise the citation and orchestration system without AI.
 */
function generateMockResponse(
  query: string,
  messages: MessageRef[],
  scope: ResolvedScope
): { response: string; citations: Citation[] } {
  const queryLower = query.toLowerCase();
  const citations: Citation[] = [];

  // Empty scope case
  if (messages.length === 0) {
    return {
      response:
        `⚠️ לא נמצאו הודעות בטווח הנבחר.\n\n` +
        `No messages found in the selected scope: ${scope.description}`,
      citations: [],
    };
  }

  // Create citations from actual messages
  const createCitation = (msg: MessageRef): Citation => ({
    messageId: msg.id,
    threadId: msg.threadId,
    subject: msg.subject,
    from: msg.from,
    date: msg.date,
    snippet: msg.snippet.slice(0, 100),
  });

  // Search-related query
  if (queryLower.includes('find') || queryLower.includes('search') || queryLower.includes('חפש')) {
    const matchingMsgs = messages.slice(0, Math.min(3, messages.length));
    matchingMsgs.forEach((m) => citations.push(createCitation(m)));

    return {
      response:
        `🔍 **תוצאות חיפוש (Mock)**\n\n` +
        `נמצאו ${messages.length} הודעות בטווח: ${scope.description}\n\n` +
        `Found ${messages.length} messages in scope. ` +
        `Showing ${citations.length} most relevant.\n\n` +
        citations
          .map(
            (c, i) =>
              `${i + 1}. **${escapeHtml(c.subject)}** מאת ${escapeHtml(c.from)}\n   ${escapeHtml(c.snippet)}...`
          )
          .join('\n\n'),
      citations,
    };
  }

  // Summary-related query
  if (
    queryLower.includes('summary') ||
    queryLower.includes('summarize') ||
    queryLower.includes('סיכום')
  ) {
    const topMsg = messages[0];
    citations.push(createCitation(topMsg));

    return {
      response:
        `📋 **סיכום (Mock)**\n\n` +
        `סורקו ${messages.length} הודעות בטווח: ${scope.description}\n\n` +
        `This is a MOCK summary. No AI processing occurred.\n` +
        `Scope: ${scope.mode}\n` +
        `Messages reviewed: ${messages.length}\n\n` +
        `Latest message: "${escapeHtml(topMsg.subject)}" from ${escapeHtml(topMsg.from)}`,
      citations,
    };
  }

  // Count/statistics query
  if (
    queryLower.includes('count') ||
    queryLower.includes('how many') ||
    queryLower.includes('כמה')
  ) {
    return {
      response:
        `📊 **סטטיסטיקה (Mock)**\n\n` +
        `סה"כ הודעות בטווח: ${messages.length}\n` +
        `Total messages in scope: ${messages.length}\n` +
        `Scope: ${scope.description}\n\n` +
        `⚠️ This is mock data - no AI analysis performed.`,
      citations: [],
    };
  }

  // Default response with citations
  const sampleMsgs = messages.slice(0, Math.min(2, messages.length));
  sampleMsgs.forEach((m) => citations.push(createCitation(m)));

  return {
    response:
      `🤖 **תגובת Mock**\n\n` +
      `שאילתה: "${escapeHtml(query)}"\n` +
      `טווח: ${scope.description}\n` +
      `הודעות בטווח: ${messages.length}\n\n` +
      `---\n\n` +
      `**⚠️ MODE: MOCK - NO AI CONNECTED**\n\n` +
      `This response is deterministic fixture output.\n` +
      `No external AI service was contacted.\n` +
      `No genuine reasoning or analysis occurred.\n\n` +
      `To test navigation, click citations below.`,
    citations,
  };
}

export class MockAIProvider implements AIProvider {
  readonly name = MOCK_PROVIDER_NAME;
  readonly isMock = true;
  readonly isConfigured = true;

  async processQuery(
    query: string,
    messages: MessageRef[],
    scope: ResolvedScope,
    budget: ProcessingBudget,
    onProgress?: (progress: SearchProgress) => void,
    signal?: AbortSignal
  ): Promise<{ response: string; citations: Citation[]; tokensUsed: number }> {
    // Simulate processing delay for realism
    const delay = Math.min(messages.length * 10, 500);

    // Report initial progress
    if (onProgress) {
      onProgress({
        totalEligible: messages.length,
        processed: 0,
        withBodies: 0,
        missingBodies: 0,
        syncCoverage: null,
        isComplete: false,
        isCancelled: false,
      });
    }

    // Simulate incremental processing
    for (let i = 0; i < messages.length && i < budget.maxMessages; i++) {
      if (signal?.aborted) {
        if (onProgress) {
          onProgress({
            totalEligible: messages.length,
            processed: i,
            withBodies: i,
            missingBodies: 0,
            syncCoverage: null,
            isComplete: false,
            isCancelled: true,
          });
        }
        throw new Error('Operation cancelled');
      }

      await new Promise((r) => setTimeout(r, Math.min(delay / messages.length, 50)));

      if (onProgress) {
        onProgress({
          totalEligible: messages.length,
          processed: i + 1,
          withBodies: i + 1,
          missingBodies: 0,
          syncCoverage: null,
          isComplete: false,
          isCancelled: false,
        });
      }
    }

    const { response, citations } = generateMockResponse(query, messages, scope);

    // Final progress
    if (onProgress) {
      onProgress({
        totalEligible: messages.length,
        processed: Math.min(messages.length, budget.maxMessages),
        withBodies: Math.min(messages.length, budget.maxMessages),
        missingBodies: 0,
        syncCoverage: 100,
        isComplete: true,
        isCancelled: false,
      });
    }

    return {
      response,
      citations,
      tokensUsed: response.length + query.length,
    };
  }
}

/** Singleton instance */
export const mockProvider = new MockAIProvider();
