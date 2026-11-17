/**
 * Offline experiment: is a Gemini Live conversation running right now?
 * The live (WebSocket) endpoint is only reachable while this is true — it is
 * opened by an explicit click on a talk / mic button and closed when the
 * session ends. No dependencies so the network guard and tests can import it.
 */
let open = 0;

export function openLiveGate(): void {
  open++;
}

export function closeLiveGate(): void {
  open = Math.max(0, open - 1);
}

export function isLiveGateOpen(): boolean {
  return open > 0;
}

export function resetLiveGateForTests(): void {
  open = 0;
}
