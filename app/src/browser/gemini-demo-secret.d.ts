export const GEMINI_DEMO_KEY_ENV: 'MAILSPRING_DEMO_GEMINI_API_KEY';
export const GEMINI_DEMO_PAID_ENV: 'MAILSPRING_DEMO_GEMINI_PAID';

export interface CapturedGeminiDemoCredentials {
  key: string;
  paidAcknowledged: boolean;
}

export function captureAndStripGeminiDemoCredentials(
  env?: NodeJS.ProcessEnv
): CapturedGeminiDemoCredentials;
export function getCapturedGeminiDemoCredentials(): CapturedGeminiDemoCredentials;
export function sanitizeSpawnEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function stripGeminiDemoCredentialNames<T extends NodeJS.ProcessEnv | undefined>(env: T): T;
export function resetGeminiDemoCredentialsForTests(): void;
