export async function settleWithinBudget(
  work: Promise<unknown>,
  signal: AbortSignal
): Promise<boolean> {
  if (signal.aborted) return false;
  const deadline = Promise.withResolvers<boolean>();
  const onAbort = (): void => deadline.resolve(false);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([work.then(() => true), deadline.promise]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
