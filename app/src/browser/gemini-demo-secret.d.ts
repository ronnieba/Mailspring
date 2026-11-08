export const GEMINI_DEMO_KEY_ENV: 'MAILSPRING_DEMO_GEMINI_API_KEY';
export const GEMINI_DEMO_PAID_ENV: 'MAILSPRING_DEMO_GEMINI_PAID';
export const GEMINI_DEMO_KEY_FILE_ENV: 'MAILSPRING_DEMO_GEMINI_KEY_FILE';
export const GEMINI_DEMO_KEYCHAIN_HELPER_ENV: 'MAILSPRING_DEMO_GEMINI_KEYCHAIN_HELPER';
export const GEMINI_DEMO_KEYCHAIN_SERVICE: 'Mailspring-demo Gemini Developer API';
export const GEMINI_DEMO_KEYCHAIN_ACCOUNT: 'gemini-demo-api-key';

export interface CapturedGeminiDemoCredentials {
  key: string;
  paidAcknowledged: boolean;
}

export type GeminiDemoCaptureSource =
  | 'key-file'
  | 'keychain'
  | 'keychain-denied'
  | 'launch-env-ignored'
  | 'none';

export function captureAndStripGeminiDemoCredentials(
  env?: NodeJS.ProcessEnv
): CapturedGeminiDemoCredentials;
export function getCapturedGeminiDemoCredentials(): CapturedGeminiDemoCredentials;
export function getGeminiDemoCaptureSource(): GeminiDemoCaptureSource;
export function formatGeminiDemoStatusLog(status: {
  keyPresent?: boolean;
  paidAcknowledged?: boolean;
  configured?: boolean;
}): string;
export function sanitizeSpawnEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function stripGeminiDemoCredentialNames<T extends NodeJS.ProcessEnv | undefined>(env: T): T;
export function resetGeminiDemoCredentialsForTests(): void;
