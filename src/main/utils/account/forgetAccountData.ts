import { session } from 'electron';
import { configGet, configSet } from '../../config.js';
import { toPartition } from '../../../shared/types/branded.js';
import type { AccountIndex } from '../../../shared/types/branded.js';
import { deleteAccountWindowPersistence } from './accountWindowPersistenceBridge.js';

export async function forgetAccountData(
  index: AccountIndex,
  removeRetainedAccount: (index: AccountIndex) => void
): Promise<void> {
  const partition = session.fromPartition(toPartition(index));
  await partition.clearStorageData();
  await partition.clearCache();
  await deleteAccountWindowPersistence(index);
  const labels = { ...configGet('app.accountLabels') };
  delete labels[String(index)];
  configSet('app.accountLabels', labels);
  removeRetainedAccount(index);
}
