import type { AccountIndex } from '../../../shared/types/branded.js';
import { configGet } from '../../config.js';

export function isAccountNotificationMuted(index: AccountIndex, now = Date.now()): boolean {
  const deadline = configGet('app.accountNotificationMuteUntil')?.[String(index)];
  return (
    typeof deadline === 'number' &&
    Number.isSafeInteger(deadline) &&
    deadline >= 0 &&
    deadline > now
  );
}
