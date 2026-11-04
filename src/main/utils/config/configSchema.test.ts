import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Conf from 'conf';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { StoreType } from '../../../shared/types/config.js';
import { CACHE_VERSION, schema } from './configSchema.js';

describe('CACHE_VERSION', () => {
  it('is the string "1.0.0"', () => {
    expect(CACHE_VERSION).toBe('1.0.0');
    expect(typeof CACHE_VERSION).toBe('string');
  });
});

describe('schema structure', () => {
  it('has the expected top-level sections', () => {
    expect(Object.keys(schema).sort()).toEqual(
      ['_meta', 'accountWindows', 'app', 'memory', 'window'].sort()
    );
  });

  it.each(['window', 'app', '_meta', 'accountWindows', 'memory'] as const)(
    'section "%s" is an object with a default object',
    (key) => {
      const section = schema[key] as { type?: string; default?: unknown };
      expect(section.type).toBe('object');
      expect(typeof section.default).toBe('object');
      expect(section.default).not.toBeNull();
    }
  );
});

describe('window section', () => {
  const window = schema.window as {
    type: string;
    properties: {
      bounds: {
        type: string;
        properties: {
          x: { type: unknown };
          y: { type: unknown };
          width: { type: unknown };
          height: { type: unknown };
        };
        default: { x: unknown; y: unknown; width: number; height: number };
      };
      isMaximized: { type: string; default: boolean };
    };
    default: {
      bounds: { x: unknown; y: unknown; width: number; height: number };
      isMaximized: boolean;
    };
  };

  it('has bounds defaults { x: null, y: null, width: 800, height: 600 }', () => {
    expect(window.properties.bounds.default).toEqual({
      x: null,
      y: null,
      width: 800,
      height: 600,
    });
  });

  it('has isMaximized default false', () => {
    expect(window.properties.isMaximized.default).toBe(false);
    expect(window.properties.isMaximized.type).toBe('boolean');
  });

  it('bounds x and y types are ["number", "null"]', () => {
    expect(window.properties.bounds.properties.x.type).toEqual(['number', 'null']);
    expect(window.properties.bounds.properties.y.type).toEqual(['number', 'null']);
  });

  it('bounds width and height types are "number"', () => {
    expect(window.properties.bounds.properties.width.type).toBe('number');
    expect(window.properties.bounds.properties.height.type).toBe('number');
  });

  it('top-level window default matches nested structure', () => {
    expect(window.default).toEqual({
      bounds: { x: null, y: null, width: 800, height: 600 },
      isMaximized: false,
    });
  });
});

describe('app section', () => {
  const app = schema.app as {
    type: string;
    properties: Record<string, { type: string | string[]; default: unknown }>;
    default: Record<string, unknown>;
  };

  const expectedBooleanDefaults: Record<string, boolean> = {
    autoCheckForUpdates: true,
    autoLaunchAtLogin: true,
    startHidden: false,
    hideMenuBar: false,
    disableSpellChecker: false,
    suppressPasskeyDialog: false,
    notificationPermissionRequested: false,
    unreadDeltaNotifications: false,
    useWebContentsView: false,
  };

  it('includes boolean app flags, accountLabels, snooze deadline, and maintenance mode', () => {
    expect(Object.keys(app.properties).sort()).toEqual(
      [
        ...Object.keys(expectedBooleanDefaults),
        'accountLabels',
        'retainedAccountIndices',
        'accountNotificationMuteUntil',
        'updateSnoozedUntil',
        'sessionMaintenanceMode',
      ].sort()
    );
    expect(app.properties['accountLabels']?.type).toBe('object');
    expect(app.default['accountLabels']).toEqual({});
  });

  it.each(Object.keys(expectedBooleanDefaults))('property "%s" is boolean', (key) => {
    expect(app.properties[key]?.type).toBe('boolean');
  });

  it.each(Object.entries(expectedBooleanDefaults))('property "%s" default is %s', (key, value) => {
    expect(app.properties[key]?.default).toBe(value);
    expect(app.default[key]).toBe(value);
  });
});

describe('app update snooze and session maintenance settings', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), 'gogchat-config-schema-'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function openStore(): Conf<StoreType> {
    return new Conf<StoreType>({ cwd, schema });
  }

  it('defaults to inactive snooze and default maintenance in property and app defaults', () => {
    const app = schema.app as {
      properties: Record<string, { default: unknown }>;
      default: Record<string, unknown>;
    };
    expect(app.properties['updateSnoozedUntil']?.default).toBe(0);
    expect(app.default['updateSnoozedUntil']).toBe(0);
    expect(app.properties['sessionMaintenanceMode']?.default).toBe('default');
    expect(app.default['sessionMaintenanceMode']).toBe('default');
  });

  it('gives a fresh store inactive snooze and default maintenance', () => {
    const store = openStore();
    expect(store.get('app.updateSnoozedUntil')).toBe(0);
    expect(store.get('app.sessionMaintenanceMode')).toBe('default');
    expect(store.get('app.retainedAccountIndices')).toEqual([0]);
    expect(store.get('app.accountNotificationMuteUntil')).toEqual({});
  });

  it('fills both defaults for an older app object without resetting other preferences', () => {
    writeFileSync(
      path.join(cwd, 'config.json'),
      JSON.stringify({ app: { autoCheckForUpdates: false, startHidden: true } })
    );
    const store = openStore();
    expect(store.get('app.autoCheckForUpdates')).toBe(false);
    expect(store.get('app.startHidden')).toBe(true);
    expect(store.get('app.updateSnoozedUntil')).toBe(0);
    expect(store.get('app.sessionMaintenanceMode')).toBe('default');
  });

  it('retains sparse membership across store reopening', () => {
    const store = openStore();
    store.set('app.retainedAccountIndices', [0, 2, 7]);
    expect(openStore().get('app.retainedAccountIndices')).toEqual([0, 2, 7]);
  });

  it('preserves unrelated preferences when legacy mute entries are malformed', () => {
    writeFileSync(
      path.join(cwd, 'config.json'),
      JSON.stringify({ app: { startHidden: true, accountNotificationMuteUntil: { '2': 'bad' } } })
    );
    const store = openStore();
    expect(store.get('app.startHidden')).toBe(true);
    expect(store.get('app.accountNotificationMuteUntil')).toEqual({ '2': 'bad' });
  });

  it.each([0, 1, 1_900_000_000_000, Number.MAX_SAFE_INTEGER])('accepts snooze deadline %s', (v) => {
    const store = openStore();
    store.set('app.updateSnoozedUntil', v);
    expect(store.get('app.updateSnoozedUntil')).toBe(v);
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 2, Number.NaN, '5', true, null])(
    'rejects snooze deadline %s',
    (v) => {
      const store = openStore();
      expect(() => store.set('app.updateSnoozedUntil', v as never)).toThrow();
      expect(store.get('app.updateSnoozedUntil')).toBe(0);
    }
  );

  it.each(['default', 'conservative'] as const)('accepts maintenance mode %s', (v) => {
    const store = openStore();
    store.set('app.sessionMaintenanceMode', v);
    expect(store.get('app.sessionMaintenanceMode')).toBe(v);
  });

  it.each(['Conservative', 'aggressive', '', 1, null])('rejects maintenance mode %s', (v) => {
    const store = openStore();
    expect(() => store.set('app.sessionMaintenanceMode', v as never)).toThrow();
    expect(store.get('app.sessionMaintenanceMode')).toBe('default');
  });
});

describe('_meta section', () => {
  const meta = schema._meta as {
    properties: {
      cacheVersion: { type: string; default: string };
      lastAppVersion: { type: string; default: string };
      lastUpdated: { type: string; default: number };
    };
    default: { cacheVersion: string; lastAppVersion: string; lastUpdated: number };
  };

  it('cacheVersion default matches CACHE_VERSION', () => {
    expect(meta.properties.cacheVersion.default).toBe(CACHE_VERSION);
    expect(meta.properties.cacheVersion.type).toBe('string');
    expect(meta.default.cacheVersion).toBe(CACHE_VERSION);
  });

  it('lastAppVersion default is empty string', () => {
    expect(meta.properties.lastAppVersion.default).toBe('');
    expect(meta.properties.lastAppVersion.type).toBe('string');
    expect(meta.default.lastAppVersion).toBe('');
  });

  it('lastUpdated property default is 0 and type is number', () => {
    expect(meta.properties.lastUpdated.default).toBe(0);
    expect(meta.properties.lastUpdated.type).toBe('number');
  });

  it('top-level default lastUpdated is a number (from Date.now())', () => {
    expect(typeof meta.default.lastUpdated).toBe('number');
    expect(meta.default.lastUpdated).toBeGreaterThanOrEqual(0);
  });
});

describe('accountWindows section', () => {
  const accountWindows = schema.accountWindows as {
    type: string;
    additionalProperties: {
      type: string;
      properties: {
        bounds: {
          type: string;
          properties: {
            x: { type: unknown };
            y: { type: unknown };
            width: { type: string };
            height: { type: string };
          };
          default: { x: unknown; y: unknown; width: number; height: number };
        };
        isMaximized: { type: string; default: boolean };
      };
      default: {
        bounds: { x: unknown; y: unknown; width: number; height: number };
        isMaximized: boolean;
      };
    };
    default: Record<string, unknown>;
  };

  it('has type "object"', () => {
    expect(accountWindows.type).toBe('object');
  });

  it('additionalProperties is an object with bounds + isMaximized', () => {
    expect(accountWindows.additionalProperties).toBeDefined();
    expect(accountWindows.additionalProperties.type).toBe('object');
    expect(Object.keys(accountWindows.additionalProperties.properties).sort()).toEqual(
      ['bounds', 'isMaximized'].sort()
    );
  });

  it('additionalProperties.bounds has x/y as ["number", "null"] and width/height as "number"', () => {
    const bounds = accountWindows.additionalProperties.properties.bounds;
    expect(bounds.properties.x.type).toEqual(['number', 'null']);
    expect(bounds.properties.y.type).toEqual(['number', 'null']);
    expect(bounds.properties.width.type).toBe('number');
    expect(bounds.properties.height.type).toBe('number');
    expect(bounds.default).toEqual({ x: null, y: null, width: 800, height: 600 });
  });

  it('additionalProperties.isMaximized defaults to false', () => {
    expect(accountWindows.additionalProperties.properties.isMaximized.type).toBe('boolean');
    expect(accountWindows.additionalProperties.properties.isMaximized.default).toBe(false);
  });

  it('default is an empty object', () => {
    expect(accountWindows.default).toEqual({});
  });
});
