import type { StoreType } from '../../../shared/types/config.js';
import type { Schema } from 'electron-store';

// ⚡ OPTIMIZATION: Cache version for invalidation on app updates
export const CACHE_VERSION = '1.0.0';

// Schema definition for electron-store
export const schema: Schema<StoreType> = {
  window: {
    type: 'object',
    properties: {
      bounds: {
        type: 'object',
        properties: {
          x: {
            type: ['number', 'null'] as const,
          },
          y: {
            type: ['number', 'null'] as const,
          },
          width: {
            type: 'number',
          },
          height: {
            type: 'number',
          },
        },
        default: {
          x: null,
          y: null,
          width: 800,
          height: 600,
        },
      },
      isMaximized: {
        type: 'boolean',
        default: false,
      },
    },
    default: {
      bounds: {
        x: null,
        y: null,
        width: 800,
        height: 600,
      },
      isMaximized: false,
    },
  },
  app: {
    type: 'object',
    properties: {
      autoCheckForUpdates: {
        type: 'boolean',
        default: true,
      },
      updateSnoozedUntil: {
        type: 'integer',
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
        default: 0,
      },
      sessionMaintenanceMode: {
        type: 'string',
        enum: ['default', 'conservative'],
        default: 'default',
      },
      autoLaunchAtLogin: {
        type: 'boolean',
        default: true,
      },
      startHidden: {
        type: 'boolean',
        default: false,
      },
      hideMenuBar: {
        type: 'boolean',
        default: false,
      },
      disableSpellChecker: {
        type: 'boolean',
        default: false,
      },
      suppressPasskeyDialog: {
        type: 'boolean',
        default: false,
      },
      notificationPermissionRequested: {
        type: 'boolean',
        default: false,
      },
      unreadDeltaNotifications: {
        type: 'boolean',
        default: false,
      },
      accountLabels: {
        type: 'object',
        additionalProperties: {
          type: 'string',
        },
        default: {},
      },
      useWebContentsView: {
        type: 'boolean',
        default: false,
      },
    },
    default: {
      autoCheckForUpdates: true,
      updateSnoozedUntil: 0,
      sessionMaintenanceMode: 'default',
      autoLaunchAtLogin: true,
      startHidden: false,
      hideMenuBar: false,
      disableSpellChecker: false,
      suppressPasskeyDialog: false,
      notificationPermissionRequested: false,
      unreadDeltaNotifications: false,
      accountLabels: {},
      useWebContentsView: false,
    },
  },
  _meta: {
    type: 'object',
    properties: {
      cacheVersion: {
        type: 'string',
        default: CACHE_VERSION,
      },
      lastAppVersion: {
        type: 'string',
        default: '',
      },
      lastUpdated: {
        type: 'number',
        default: 0,
      },
    },
    default: {
      cacheVersion: CACHE_VERSION,
      lastAppVersion: '',
      lastUpdated: Date.now(),
    },
  },
  accountWindows: {
    type: 'object',
    additionalProperties: {
      type: 'object',
      properties: {
        bounds: {
          type: 'object',
          properties: {
            x: {
              type: ['number', 'null'] as const,
            },
            y: {
              type: ['number', 'null'] as const,
            },
            width: {
              type: 'number',
            },
            height: {
              type: 'number',
            },
          },
          default: {
            x: null,
            y: null,
            width: 800,
            height: 600,
          },
        },
        isMaximized: {
          type: 'boolean',
          default: false,
        },
      },
      default: {
        bounds: {
          x: null,
          y: null,
          width: 800,
          height: 600,
        },
        isMaximized: false,
      },
    },
    default: {},
  },
  memory: {
    type: 'object',
    properties: {
      dehydrationThresholdMs: {
        type: 'number',
      },
      v8HeapCapMB: {
        type: 'number',
      },
      diskCacheMaxMB: {
        type: 'number',
      },
    },
    default: {},
  },
};
