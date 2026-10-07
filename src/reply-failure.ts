/** Never repeat an uncertain delivery or replay work. Only a pre-delivery deadline gets a notice. */
export function replyFailureGate(current: () => boolean) {
  let attempted = false;
  return {
    deliveryStarted() { attempted = true; },
    shouldNotify(error: unknown) {
      if (attempted || !current()) return false;
      return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    },
  };
}
