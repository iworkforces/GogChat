/**
 * Common IPC Validators
 *
 * Reusable validator functions for IPC message payloads.
 */

import { IPCError } from '../lifecycle/errors.js';
import { asType } from '../../../shared/typeUtils.js';

/**
 * Common validators that can be reused across IPC handlers
 */
export const commonValidators = {
  /** Validates that data is a non-null object */
  isObject: (data: unknown): Record<string, unknown> => {
    if (typeof data !== 'object' || data === null) {
      throw new IPCError('Expected object', 'IPC_INVALID_PAYLOAD');
    }
    return asType<Record<string, unknown>>(data);
  },

  /** Validates that data is a string */
  isString: (data: unknown): string => {
    if (typeof data !== 'string') {
      throw new IPCError('Expected string', 'IPC_INVALID_PAYLOAD');
    }
    return data;
  },

  /** Validates that data is a number */
  isNumber: (data: unknown): number => {
    if (typeof data !== 'number' || isNaN(data)) {
      throw new IPCError('Expected valid number', 'IPC_INVALID_PAYLOAD');
    }
    return data;
  },

  /** Validates that data is a boolean */
  isBoolean: (data: unknown): boolean => {
    if (typeof data !== 'boolean') {
      throw new IPCError('Expected boolean', 'IPC_INVALID_PAYLOAD');
    }
    return data;
  },

  /** No-op validator for void/empty channels */
  noData: (_data: unknown): void => {
    /* Intentionally empty - for channels with no payload */
  },
};
