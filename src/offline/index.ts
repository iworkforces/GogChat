((window: Window) => {
  // eslint-disable-next-line no-restricted-syntax -- offline page cannot import from shared/
  const btn = window.document.getElementById('retry-btn') as HTMLButtonElement;
  const status = window.document.getElementById('retry-status');
  const MAX_AUTO_ATTEMPT_COUNT = 100;
  let automaticAttemptCount = 0;
  let pending = false;

  const describeFailure = (detail: unknown): string => {
    const outcome: unknown =
      typeof detail === 'object' && detail ? Reflect.get(detail, 'outcome') : null;
    const httpStatus: unknown =
      typeof detail === 'object' && detail ? Reflect.get(detail, 'httpStatus') : null;
    switch (outcome) {
      case 'http-error':
        return typeof httpStatus === 'number' &&
          Number.isInteger(httpStatus) &&
          httpStatus >= 300 &&
          httpStatus <= 599
          ? `The server responded with an error (HTTP ${httpStatus}). Try again shortly.`
          : 'The server responded with an error. Try again shortly.';
      case 'network-error':
        return 'The request failed before the server answered. Check your connection and retry.';
      case 'timeout':
        return 'The server did not answer in time. Retry when your connection improves.';
      default:
        return 'Could not reach GogChat. Retry when your connection improves.';
    }
  };

  const showFeedback = (text: string) => {
    if (status) {
      status.textContent = text;
    }
  };

  const restoreRetryState = (event: Event) => {
    pending = false;
    btn.disabled = false;
    btn.innerText = 'Retry';
    showFeedback(describeFailure('detail' in event ? event.detail : null));
  };

  const checkIsOnline = () => {
    pending = true;
    btn.disabled = false;
    btn.innerText = 'Cancel';
    showFeedback('');

    // This script does not have access to Electron APIs (IPC)
    // So let's notify the preload script via a global event
    window.dispatchEvent(new Event('app:checkIfOnline'));
  };

  // Preload signals failed checks via DOM event so we re-enable retry without
  // reloading the offline document.
  window.addEventListener('app:onlineCheckFailed', restoreRetryState);

  btn.addEventListener('click', () => {
    if (!pending) {
      checkIsOnline();
      return;
    }
    pending = false;
    btn.innerText = 'Retry';
    showFeedback('Connectivity check cancelled.');
    window.dispatchEvent(new Event('app:cancelOnlineCheck'));
  });
  const interval = window.setInterval(() => {
    if (pending) return;
    checkIsOnline();
    automaticAttemptCount++;
    if (automaticAttemptCount === MAX_AUTO_ATTEMPT_COUNT) {
      window.clearInterval(interval);
    }
  }, 1000 * 60);
})(window);
