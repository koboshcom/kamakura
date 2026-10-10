/** Stop generation only when the model explicitly finishes a delivered casual reply.
 * No text inference, automatic send, deduplication or limit on additive bubbles.
 */
export function chatCompletion() {
  let finished = false;
  return {
    delivered(purpose?: string, finishTurn?: boolean) {
      if (purpose === 'chat' && finishTurn === true) finished = true;
    },
    canStop(pendingWork: boolean) { return finished && !pendingWork; },
  };
}
