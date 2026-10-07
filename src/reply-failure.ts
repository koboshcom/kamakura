/** Never repeat uncertain delivery, replay work or let a cancelled tool deliver late. */
export function replyFailureGate(current: () => boolean) {
  let attempted = false;
  let open = true;
  return {
    current() { return open && current(); },
    close() { open = false; },
    deliveryStarted() {
      if (!open || !current()) throw new Error('Turn unavailable before delivery');
      attempted = true;
    },
    noticeStarted() {
      if (attempted || !current()) throw new Error('Failure notice unavailable');
      attempted = true;
    },
    shouldNotify(error: unknown) {
      if (attempted || !current()) return false;
      return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    },
  };
}
