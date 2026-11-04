import { configGet, configSet } from '../../config.js';
import { asAccountIndex } from '../../../shared/types/branded.js';
import type { AccountIndex } from '../../../shared/types/branded.js';

export function listRetainedAccountIndices(): AccountIndex[] {
  const indices = configGet('app.retainedAccountIndices') ?? [0];
  return [...new Set([0, ...indices])].sort((a, b) => a - b).map(asAccountIndex);
}

export function retainAccount(index: AccountIndex): void {
  const indices = listRetainedAccountIndices();
  if (!indices.includes(index)) {
    configSet(
      'app.retainedAccountIndices',
      [...indices, index].sort((a, b) => a - b)
    );
  }
}

export function removeRetainedAccount(index: AccountIndex): void {
  configSet(
    'app.retainedAccountIndices',
    listRetainedAccountIndices().filter((i) => i !== index)
  );
}

export class AccountForgetter {
  private readonly pending = new Map<AccountIndex, Promise<void>>();

  assertAvailable(index: AccountIndex): void {
    if (this.pending.has(index)) throw new Error(`Account ${index} is being forgotten`);
  }

  forget(index: AccountIndex, bootstrap: boolean, dispose: () => void): Promise<void> {
    const existing = this.pending.get(index);
    if (existing) return existing;
    if (index === 0 || bootstrap) return Promise.reject(new Error('Cannot forget this account'));
    const operation = Promise.resolve()
      .then(async () => {
        dispose();
        const { forgetAccountData } = await import('./forgetAccountData.js');
        await forgetAccountData(index, removeRetainedAccount);
      })
      .finally(() => this.pending.delete(index));
    this.pending.set(index, operation);
    return operation;
  }
}
