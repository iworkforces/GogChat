/**
 * Unit tests for badgeHelpers — extracted IPC logic for badgeIcon feature.
 *
 * Covers:
 *   • decideIcon()         — favicon URL → IconType resolution
 *   • updateBadgeIcon()    — macOS dock badge update
 *   • setupBadgeHandlers() — IPC handler registration via registerFastHandler
 *                             with rate limiting + validation.
 *   • Inline caching       — identical consecutive payloads short-circuit
 *                             via last-value comparison (replaces dedup map).
 *   • Burst regression     — rapid identical payloads collapse to one
 *                             downstream call via the inline cache.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { IpcMainEvent } from 'electron';
import { asType } from '../../../shared/typeUtils.js';
import { asAccountIndex } from '../../../shared/types/branded.js';
import type { AccountIndex } from '../../../shared/types/branded.js';
import type { IAccountWindowManager } from '../../../shared/types/window.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockSetBadgeCount = vi.fn();
const mockPlatformState = vi.hoisted(() => ({
  supportsDockBadge: true,
  useTemplateTrayIcon: true,
}));
vi.mock('electron', () => ({
  app: { setBadgeCount: mockSetBadgeCount },
  BrowserWindow: vi.fn(),
  Tray: vi.fn(),
  ipcMain: {
    on: vi.fn(),
    handle: vi.fn(),
    removeListener: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

const mockGetIcon = vi.fn().mockReturnValue('/fake/icon.png');
vi.mock('./iconCache.js', () => ({
  getIconCache: () => ({ getIcon: mockGetIcon }),
}));

const mockIsAccountVisible = vi.fn(() => true);
const mockGetAccountWindowManager = vi.fn(() => ({
  isAccountVisible: (...args: unknown[]) => mockIsAccountVisible(...args),
}));
vi.mock('../account/accountWindowManager.js', () => ({
  getAccountWindowManager: (...args: unknown[]) => mockGetAccountWindowManager(...args),
}));

const mockSetTrayUnread = vi.fn();
vi.mock('./trayIconState.js', () => ({
  setTrayUnread: mockSetTrayUnread,
}));

vi.mock('./platformDetection.js', () => ({
  platform: {
    config: mockPlatformState,
  },
}));

vi.mock('../../../shared/dataValidators.js', () => ({
  validateFaviconURL: vi.fn((url: string) => url),
  validateUnreadCount: vi.fn((count: number) => count),
}));

const mockConfigGet = vi.fn().mockReturnValue(false);
vi.mock('../../config.js', () => ({
  configGet: (...args: unknown[]) => mockConfigGet(...args),
}));

const mockShowNativeNotification = vi.fn().mockReturnValue(true);
const mockWasBridgeRecently = vi.fn().mockReturnValue(false);
const mockEnsureNotificationPermission = vi.fn().mockReturnValue('already-requested');
const mockResolveFocusWindow = vi.fn((event: unknown, fallback: unknown) => fallback);
const mockResolveAccount = vi.fn().mockReturnValue(0);
const mockBuildPayload = vi.fn((opts: Record<string, unknown>) => ({
  title: opts['title'],
  body: opts['body'],
  tag: `a0:${opts['chatTag']}`,
  subtitle: 'Account 1',
  groupId: 'gogchat-account-0',
}));
vi.mock('./nativeNotification.js', () => ({
  showNativeNotification: (...args: unknown[]) => mockShowNativeNotification(...args),
  wasBridgeNotificationRecentlyShown: (...args: unknown[]) => mockWasBridgeRecently(...args),
  buildAccountAwareNotificationPayload: (...args: unknown[]) =>
    mockBuildPayload(...(args as [Record<string, unknown>])),
  buildUnreadDeltaNotificationBody: (count: number) =>
    count === 1
      ? 'You have a new unread message'
      : count > 99
        ? 'You have 99+ unread messages'
        : `You have ${count} unread messages`,
  shouldShowUnreadDeltaNotification: (opts: {
    enabled: boolean;
    previousCount: number | undefined;
    nextCount: number;
    isWindowFocused: boolean;
    bridgeCooldownActive?: boolean;
  }) =>
    opts.enabled &&
    !opts.isWindowFocused &&
    opts.bridgeCooldownActive !== true &&
    opts.previousCount !== undefined &&
    opts.nextCount > opts.previousCount &&
    opts.nextCount > 0,
  clampBadgeDisplayCount: (count: number) => (count <= 0 ? 0 : count > 99 ? 99 : Math.floor(count)),
}));
vi.mock('./accountNotificationIdentity.js', () => ({
  resolveAccountIndexFromIpcEvent: (...args: unknown[]) => mockResolveAccount(...args),
  UNREAD_DELTA_TAG_BASE: 'gogchat-unread-delta',
  formatAccountNotificationLabel: (idx: number | null) =>
    idx === null ? 'GogChat' : `Account ${idx + 1}`,
  accountNotificationGroupId: (idx: number | null) =>
    idx === null ? 'gogchat-account-unknown' : `gogchat-account-${idx}`,
  namespaceNotificationTag: (idx: number | null, tag?: string) => {
    const prefix = idx === null ? 'a?' : `a${idx}`;
    return `${prefix}:${tag ?? 'notif'}`;
  },
}));
vi.mock('./notificationFocus.js', () => ({
  resolveNotificationFocusWindow: (...args: unknown[]) => mockResolveFocusWindow(...args),
  focusNotificationSource: vi.fn(),
}));
vi.mock('../security/notificationAccess.js', () => ({
  ensureNotificationPermission: (...args: unknown[]) => mockEnsureNotificationPermission(...args),
}));

function fakeWindow(overrides: { isFocused?: boolean } = {}) {
  return {
    isDestroyed: vi.fn().mockReturnValue(false),
    isFocused: vi.fn().mockReturnValue(overrides.isFocused ?? false),
  } as unknown as Electron.BrowserWindow;
}
function fakeTray() {
  return { setImage: vi.fn() } as unknown as Electron.Tray;
}

const liveWebContents = new Map<AccountIndex, Electron.WebContents>();
function eventForAccount(accountIndex = 0): IpcMainEvent {
  const sender = liveWebContents.get(asAccountIndex(accountIndex));
  if (!sender) throw new Error(`Missing test sender for account ${accountIndex}`);
  return asType<IpcMainEvent>({ sender });
}

async function backfillLiveAccounts(): Promise<void> {
  const hooks = await import('../account/accountWebContentsHooks.js');
  hooks.clearAccountWebContentsHooksForTests();
  liveWebContents.clear();
  for (const index of [0, 1, 2, 7]) {
    liveWebContents.set(
      asAccountIndex(index),
      asType<Electron.WebContents>({
        id: index + 1,
        isDestroyed: vi.fn(() => false),
      })
    );
  }
  hooks.setAccountWebContentsHooksManager(
    asType<IAccountWindowManager>({
      enumerateAccountWebContents: () =>
        [...liveWebContents].map(([accountIndex, webContents]) => ({
          accountIndex,
          webContents,
          backend: 'browser-window',
        })),
    })
  );
  mockResolveAccount.mockImplementation((event: IpcMainEvent) => {
    for (const [accountIndex, webContents] of liveWebContents) {
      if (event.sender === webContents) return accountIndex;
    }
    return null;
  });
}

// ─── Config-shape tests (mocked registerFastHandler) ─────────────────────────

describe('badgeHelpers (config wiring)', () => {
  const mockRegisterFastHandler = vi.fn().mockReturnValue(vi.fn());

  function capturedHandler<T>(channel: string): (value: T, event: IpcMainEvent) => void {
    const config = asType<{ handler: (value: T, event: IpcMainEvent) => void }>(
      mockRegisterFastHandler.mock.calls.find(([candidate]) => candidate.channel === channel)?.[0]
    );
    return config.handler;
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('../ipc/ipcFastPath.js', () => ({
      registerFastHandler: (cfg: unknown) => mockRegisterFastHandler(cfg),
    }));
    mockRegisterFastHandler.mockClear();
    mockRegisterFastHandler.mockReturnValue(vi.fn());
    mockSetBadgeCount.mockClear();
    mockGetIcon.mockClear().mockReturnValue('/fake/icon.png');
    mockSetTrayUnread.mockClear();
    mockShowNativeNotification.mockClear();
    mockWasBridgeRecently.mockClear();
    mockWasBridgeRecently.mockReturnValue(false);
    mockEnsureNotificationPermission.mockClear();
    mockResolveFocusWindow.mockImplementation((_e: unknown, fb: unknown) => fb);
    await backfillLiveAccounts();
    mockIsAccountVisible.mockReturnValue(true);
    mockBuildPayload.mockClear();
    mockConfigGet.mockReturnValue(false);
    mockPlatformState.supportsDockBadge = true;
    mockPlatformState.useTemplateTrayIcon = true;
  });

  afterEach(() => {
    vi.doUnmock('../ipc/ipcFastPath.js');
  });

  describe('decideIcon', () => {
    it('returns NORMAL or BADGE for matching favicons, OFFLINE otherwise', async () => {
      const { decideIcon } = await import('./badgeHelpers.js');
      const { ICON_TYPES } = await import('../../../shared/constants.js');
      expect(decideIcon('https://example.com/something-random.png')).toBe(ICON_TYPES.OFFLINE);
      expect(decideIcon('https://mail.google.com/favicon_chat_r2.ico')).toBe(ICON_TYPES.NORMAL);
      expect(decideIcon('https://mail.google.com/favicon_chat_new_notif_r2.ico')).toBe(
        ICON_TYPES.BADGE
      );
      expect(decideIcon('https://mail.google.com/favicon.ico')).toBe(ICON_TYPES.OFFLINE);
    });
  });

  describe('updateBadgeIcon', () => {
    it('forwards the count to app.setBadgeCount on macOS', async () => {
      const { updateBadgeIcon } = await import('./badgeHelpers.js');
      updateBadgeIcon(fakeWindow(), 7);
      expect(mockSetBadgeCount).toHaveBeenCalledWith(7);
    });

    it('does not claim a Windows taskbar badge when platform support is disabled', async () => {
      mockPlatformState.supportsDockBadge = false;

      const { updateBadgeIcon } = await import('./badgeHelpers.js');
      updateBadgeIcon(fakeWindow(), 7);

      expect(mockSetBadgeCount).not.toHaveBeenCalled();
    });
  });

  describe('setupBadgeHandlers', () => {
    it('registers FAVICON_CHANGED handler with validator and rate limit', async () => {
      const { setupBadgeHandlers } = await import('./badgeHelpers.js');
      setupBadgeHandlers(fakeWindow(), fakeTray());

      expect(mockRegisterFastHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'faviconChanged',
          validator: expect.any(Function),
          handler: expect.any(Function),
          rateLimit: 5,
        })
      );
    });

    it('registers UNREAD_COUNT handler with validator and rate limit', async () => {
      const { setupBadgeHandlers } = await import('./badgeHelpers.js');
      setupBadgeHandlers(fakeWindow(), fakeTray());

      expect(mockRegisterFastHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'unreadCount',
          validator: expect.any(Function),
          handler: expect.any(Function),
          rateLimit: 5,
        })
      );
    });

    it('returns cleanup callbacks for both handlers', async () => {
      const faviconCleanupFn = vi.fn();
      const unreadCleanupFn = vi.fn();
      mockRegisterFastHandler
        .mockReturnValueOnce(faviconCleanupFn)
        .mockReturnValueOnce(unreadCleanupFn);

      const { setupBadgeHandlers } = await import('./badgeHelpers.js');
      const { faviconCleanup, unreadCleanup } = setupBadgeHandlers(fakeWindow(), fakeTray());

      expect(faviconCleanup).toBe(faviconCleanupFn);
      expect(unreadCleanup).toBe(unreadCleanupFn);
    });

    it('short-circuits identical consecutive FAVICON_CHANGED payloads (inline cache)', async () => {
      const { setupBadgeHandlers } = await import('./badgeHelpers.js');
      setupBadgeHandlers(fakeWindow(), fakeTray());

      const faviconCfg = mockRegisterFastHandler.mock.calls.find(
        ([cfg]) => (cfg as { channel: string }).channel === 'faviconChanged'
      )?.[0] as { handler: (v: string, event: IpcMainEvent) => void };

      mockSetTrayUnread.mockClear();
      faviconCfg.handler(
        'https://mail.google.com/favicon_chat_new_notif_r2.ico',
        eventForAccount()
      );
      faviconCfg.handler(
        'https://mail.google.com/favicon_chat_new_notif_r2.ico',
        eventForAccount()
      );
      faviconCfg.handler(
        'https://mail.google.com/favicon_chat_new_notif_r2.ico',
        eventForAccount()
      );

      // setTrayUnread runs inside the handler body — should be called once
      expect(mockSetTrayUnread).toHaveBeenCalledTimes(1);
    });

    it('short-circuits identical consecutive UNREAD_COUNT payloads (inline cache)', async () => {
      const { setupBadgeHandlers } = await import('./badgeHelpers.js');
      setupBadgeHandlers(fakeWindow(), fakeTray());

      const unreadCfg = mockRegisterFastHandler.mock.calls.find(
        ([cfg]) => (cfg as { channel: string }).channel === 'unreadCount'
      )?.[0] as { handler: (v: number, event: IpcMainEvent) => void };

      unreadCfg.handler(7, eventForAccount());
      unreadCfg.handler(7, eventForAccount());
      unreadCfg.handler(7, eventForAccount());

      expect(mockSetBadgeCount).toHaveBeenCalledTimes(1);
      expect(mockSetBadgeCount).toHaveBeenCalledWith(7);
    });

    it('handler updates dock badge and tray when invoked', async () => {
      const { setupBadgeHandlers } = await import('./badgeHelpers.js');
      setupBadgeHandlers(fakeWindow(), fakeTray());

      const unreadCfg = mockRegisterFastHandler.mock.calls.find(
        ([cfg]) => (cfg as { channel: string }).channel === 'unreadCount'
      )?.[0] as { handler: (v: number, event: IpcMainEvent) => void };
      unreadCfg.handler(5, eventForAccount());

      expect(mockSetBadgeCount).toHaveBeenCalledWith(5);
      expect(mockSetTrayUnread).toHaveBeenCalledWith(true);
    });

    it('handler clears tray unread when count is 0', async () => {
      const { setupBadgeHandlers } = await import('./badgeHelpers.js');
      setupBadgeHandlers(fakeWindow(), fakeTray());

      const unreadCfg = mockRegisterFastHandler.mock.calls.find(
        ([cfg]) => (cfg as { channel: string }).channel === 'unreadCount'
      )?.[0] as { handler: (v: number, event: IpcMainEvent) => void };
      unreadCfg.handler(0, eventForAccount());

      expect(mockSetTrayUnread).toHaveBeenCalledWith(false);
    });

    it('retains an unknown-count badge favicon when another live account reports normal', async () => {
      const { setupBadgeHandlers } = await import('./badgeHelpers.js');
      const hooks = await import('../account/accountWebContentsHooks.js');
      const first = asType<Electron.WebContents>({ id: 101, isDestroyed: () => false });
      const second = asType<Electron.WebContents>({ id: 102, isDestroyed: () => false });
      mockResolveAccount.mockImplementation((event: IpcMainEvent) =>
        event.sender === first ? asAccountIndex(0) : asAccountIndex(2)
      );
      hooks.setAccountWebContentsHooksManager(
        asType<IAccountWindowManager>({
          enumerateAccountWebContents: () => [
            { accountIndex: asAccountIndex(0), webContents: first, backend: 'browser-window' },
            { accountIndex: asAccountIndex(2), webContents: second, backend: 'browser-window' },
          ],
        })
      );
      const cleanups = setupBadgeHandlers(fakeWindow(), fakeTray());
      const config = asType<{ handler: (value: string, event: IpcMainEvent) => void }>(
        mockRegisterFastHandler.mock.calls.find(([cfg]) => cfg.channel === 'faviconChanged')?.[0]
      );

      config.handler(
        'https://mail.google.com/favicon_chat_new_notif_r2.ico',
        asType<IpcMainEvent>({ sender: first })
      );
      config.handler(
        'https://mail.google.com/favicon_chat_r2.ico',
        asType<IpcMainEvent>({ sender: second })
      );

      expect(mockSetTrayUnread).toHaveBeenLastCalledWith(true);
      for (const cleanup of Object.values(cleanups)) cleanup();
      hooks.clearAccountWebContentsHooksForTests();
    });

    it('does not show unread-delta notification when flag is off', async () => {
      mockConfigGet.mockReturnValue(false);
      const { setupBadgeHandlers } = await import('./badgeHelpers.js');
      setupBadgeHandlers(fakeWindow({ isFocused: false }), fakeTray());

      const unreadCfg = mockRegisterFastHandler.mock.calls.find(
        ([cfg]) => (cfg as { channel: string }).channel === 'unreadCount'
      )?.[0] as { handler: (v: number, e?: unknown) => void };
      const event = eventForAccount();
      unreadCfg.handler(1, event);
      unreadCfg.handler(2, event);

      expect(mockShowNativeNotification).not.toHaveBeenCalled();
    });

    it('short-circuits when same account reports the same count again', async () => {
      mockResolveAccount.mockReturnValue(0);
      const { setupBadgeHandlers } = await import('./badgeHelpers.js');
      setupBadgeHandlers(fakeWindow(), fakeTray());
      const unreadCfg = mockRegisterFastHandler.mock.calls.find(
        ([cfg]) => (cfg as { channel: string }).channel === 'unreadCount'
      )?.[0] as { handler: (v: number, e?: unknown) => void };
      mockSetBadgeCount.mockClear();
      unreadCfg.handler(5, eventForAccount());
      unreadCfg.handler(5, eventForAccount());
      expect(mockSetBadgeCount).toHaveBeenCalledTimes(1);
    });

    it('updates non-template tray icon when favicon type changes', async () => {
      mockPlatformState.useTemplateTrayIcon = false;
      const tray = fakeTray();
      const { setupBadgeHandlers } = await import('./badgeHelpers.js');
      setupBadgeHandlers(fakeWindow(), tray);
      const faviconCfg = mockRegisterFastHandler.mock.calls.find(
        ([cfg]) => (cfg as { channel: string }).channel === 'faviconChanged'
      )?.[0] as { handler: (v: string, event: IpcMainEvent) => void };
      faviconCfg.handler('https://mail.google.com/favicon_chat_r2.ico', eventForAccount());
      faviconCfg.handler(
        'https://mail.google.com/favicon_chat_new_notif_r2.ico',
        eventForAccount()
      );
      expect(tray.setImage).toHaveBeenCalled();
      mockPlatformState.useTemplateTrayIcon = true;
    });

    it('shows unread-delta notification on unfocused increase when enabled', async () => {
      mockConfigGet.mockImplementation((key: string) => key === 'app.unreadDeltaNotifications');
      const win = fakeWindow({ isFocused: false });
      const { setupBadgeHandlers } = await import('./badgeHelpers.js');
      setupBadgeHandlers(win, fakeTray());

      const unreadCfg = mockRegisterFastHandler.mock.calls.find(
        ([cfg]) => (cfg as { channel: string }).channel === 'unreadCount'
      )?.[0] as { handler: (v: number, e?: unknown) => void };
      const event = eventForAccount();
      unreadCfg.handler(1, event);
      expect(mockShowNativeNotification).not.toHaveBeenCalled(); // first observation

      unreadCfg.handler(3, event);
      expect(mockEnsureNotificationPermission).toHaveBeenCalled();
      expect(mockBuildPayload).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'GogChat',
          body: 'You have 3 unread messages',
          chatTag: 'gogchat-unread-delta',
          accountIndex: 0,
        })
      );
      expect(mockShowNativeNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          subtitle: 'Account 1',
          tag: 'a0:gogchat-unread-delta',
        }),
        expect.objectContaining({
          focusWindow: win,
          ipcEvent: event,
          source: 'unread-delta',
          accountIndex: 0,
        })
      );
    });

    it('sums per-account unread for dock badge and caps display at 99', async () => {
      mockResolveAccount.mockReturnValueOnce(0).mockReturnValueOnce(1);
      const { setupBadgeHandlers, sumAccountUnreadCounts, updateBadgeIcon } =
        await import('./badgeHelpers.js');
      setupBadgeHandlers(fakeWindow(), fakeTray());

      const unreadCfg = mockRegisterFastHandler.mock.calls.find(
        ([cfg]) => (cfg as { channel: string }).channel === 'unreadCount'
      )?.[0] as { handler: (v: number, e?: unknown) => void };

      unreadCfg.handler(40, eventForAccount());
      unreadCfg.handler(70, eventForAccount(1));

      // sum 110 → display 99
      expect(mockSetBadgeCount).toHaveBeenLastCalledWith(99);

      const map = new Map([
        ['0', 10],
        ['1', 20],
      ]);
      expect(sumAccountUnreadCounts(map)).toBe(30);
      mockPlatformState.supportsDockBadge = false;
      mockSetBadgeCount.mockClear();
      updateBadgeIcon(fakeWindow(), 5);
      expect(mockSetBadgeCount).not.toHaveBeenCalled();
      mockPlatformState.supportsDockBadge = true;
    });

    it('skips unread-delta notification when window is focused', async () => {
      mockConfigGet.mockImplementation((key: string) => key === 'app.unreadDeltaNotifications');
      mockIsAccountVisible.mockReturnValue(true);
      const { setupBadgeHandlers } = await import('./badgeHelpers.js');
      setupBadgeHandlers(fakeWindow({ isFocused: true }), fakeTray());

      const unreadCfg = mockRegisterFastHandler.mock.calls.find(
        ([cfg]) => (cfg as { channel: string }).channel === 'unreadCount'
      )?.[0] as { handler: (v: number, e?: unknown) => void };
      unreadCfg.handler(1, eventForAccount());
      unreadCfg.handler(2, eventForAccount());

      expect(mockShowNativeNotification).not.toHaveBeenCalled();
    });

    it('shows unread-delta when host focused but account is not visible (WCV hidden-live)', async () => {
      mockConfigGet.mockImplementation((key: string) => key === 'app.unreadDeltaNotifications');
      mockIsAccountVisible.mockReturnValue(false);
      mockResolveAccount.mockReturnValue(1);
      const { setupBadgeHandlers } = await import('./badgeHelpers.js');
      setupBadgeHandlers(fakeWindow({ isFocused: true }), fakeTray());

      const unreadCfg = mockRegisterFastHandler.mock.calls.find(
        ([cfg]) => (cfg as { channel: string }).channel === 'unreadCount'
      )?.[0] as { handler: (v: number, e?: unknown) => void };
      const event = eventForAccount(1);
      unreadCfg.handler(1, event);
      unreadCfg.handler(3, event);

      expect(mockIsAccountVisible).toHaveBeenCalledWith(1);
      expect(mockShowNativeNotification).toHaveBeenCalled();
      mockResolveAccount.mockReturnValue(0);
      mockIsAccountVisible.mockReturnValue(true);
    });

    it('skips unread-delta when bridge cooldown is active', async () => {
      mockConfigGet.mockImplementation((key: string) => key === 'app.unreadDeltaNotifications');
      mockWasBridgeRecently.mockReturnValue(true);
      const { setupBadgeHandlers } = await import('./badgeHelpers.js');
      setupBadgeHandlers(fakeWindow({ isFocused: false }), fakeTray());

      const unreadCfg = mockRegisterFastHandler.mock.calls.find(
        ([cfg]) => (cfg as { channel: string }).channel === 'unreadCount'
      )?.[0] as { handler: (v: number, e?: unknown) => void };
      unreadCfg.handler(1, eventForAccount());
      unreadCfg.handler(2, eventForAccount());

      expect(mockShowNativeNotification).not.toHaveBeenCalled();
    });

    it('catches unread-delta show errors without throwing', async () => {
      mockConfigGet.mockImplementation((key: string) => key === 'app.unreadDeltaNotifications');
      mockShowNativeNotification.mockImplementation(() => {
        throw new Error('show fail');
      });
      const { setupBadgeHandlers } = await import('./badgeHelpers.js');
      setupBadgeHandlers(fakeWindow({ isFocused: false }), fakeTray());
      const unreadCfg = mockRegisterFastHandler.mock.calls.find(
        ([cfg]) => (cfg as { channel: string }).channel === 'unreadCount'
      )?.[0] as { handler: (v: number, e?: unknown) => void };
      expect(() => {
        unreadCfg.handler(1, eventForAccount());
        unreadCfg.handler(2, eventForAccount());
      }).not.toThrow();
      mockShowNativeNotification.mockReturnValue(true);
    });

    it('clears tray unread when total becomes zero', async () => {
      mockResolveAccount.mockReturnValue(0);
      const { setupBadgeHandlers } = await import('./badgeHelpers.js');
      setupBadgeHandlers(fakeWindow(), fakeTray());
      const unreadCfg = mockRegisterFastHandler.mock.calls.find(
        ([cfg]) => (cfg as { channel: string }).channel === 'unreadCount'
      )?.[0] as { handler: (v: number, e?: unknown) => void };
      unreadCfg.handler(2, eventForAccount());
      unreadCfg.handler(0, eventForAccount());
      expect(mockSetTrayUnread).toHaveBeenLastCalledWith(false);
    });

    it('rejects an unmapped account without badge or unread-delta effects', async () => {
      mockResolveAccount.mockReturnValue(null);
      mockConfigGet.mockImplementation((key: string) => key === 'app.unreadDeltaNotifications');
      const { setupBadgeHandlers } = await import('./badgeHelpers.js');
      setupBadgeHandlers(fakeWindow({ isFocused: true }), fakeTray());
      const unreadCfg = mockRegisterFastHandler.mock.calls.find(
        ([cfg]) => (cfg as { channel: string }).channel === 'unreadCount'
      )?.[0] as { handler: (v: number, e?: unknown) => void };
      mockShowNativeNotification.mockClear();
      unreadCfg.handler(1, eventForAccount());
      unreadCfg.handler(4, eventForAccount());
      expect(mockShowNativeNotification).not.toHaveBeenCalled();
      expect(mockSetBadgeCount).not.toHaveBeenCalled();
      expect(mockSetTrayUnread).not.toHaveBeenCalled();
    });

    it('skips redundant setImage when tray type unchanged on non-template icons', async () => {
      mockPlatformState.useTemplateTrayIcon = false;
      const tray = fakeTray();
      const { setupBadgeHandlers } = await import('./badgeHelpers.js');
      setupBadgeHandlers(fakeWindow(), tray);
      const faviconCfg = mockRegisterFastHandler.mock.calls.find(
        ([cfg]) => (cfg as { channel: string }).channel === 'faviconChanged'
      )?.[0] as { handler: (v: string, event: IpcMainEvent) => void };
      faviconCfg.handler('https://mail.google.com/favicon_chat_r2.ico', eventForAccount());
      vi.mocked(tray.setImage).mockClear();
      faviconCfg.handler(
        'https://mail.google.com/favicon_chat_r2.ico?revision=2',
        eventForAccount()
      );
      faviconCfg.handler('https://mail.google.com/favicon_chat_r2.ico', eventForAccount());
      expect(tray.setImage).not.toHaveBeenCalled();
      mockPlatformState.useTemplateTrayIcon = true;
    });

    it('uses the favicon icon variant on Windows-style tray icons without template unread toggles', async () => {
      mockPlatformState.useTemplateTrayIcon = false;
      const tray = fakeTray();

      const { setupBadgeHandlers } = await import('./badgeHelpers.js');
      setupBadgeHandlers(fakeWindow(), tray);

      const faviconCfg = mockRegisterFastHandler.mock.calls.find(
        ([cfg]) => (cfg as { channel: string }).channel === 'faviconChanged'
      )?.[0] as { handler: (v: string, event: IpcMainEvent) => void };
      faviconCfg.handler('https://mail.google.com/favicon_chat_r2.ico', eventForAccount());

      expect(mockSetTrayUnread).not.toHaveBeenCalled();
      expect(mockGetIcon).toHaveBeenCalledWith(expect.stringMatching(/^resources\/icons\//));
      expect(tray.setImage).toHaveBeenCalledWith('/fake/icon.png');
    });

    it.each([true, false])(
      'uses aggregate count precedence with template tray = %s',
      async (template) => {
        mockPlatformState.useTemplateTrayIcon = template;
        const { setupBadgeHandlers } = await import('./badgeHelpers.js');
        const tray = fakeTray();
        setupBadgeHandlers(fakeWindow(), tray);
        const favicon = capturedHandler<string>('faviconChanged');
        const unread = capturedHandler<number>('unreadCount');
        const badge = 'https://mail.google.com/favicon_chat_new_notif_r2.ico';
        const normal = 'https://mail.google.com/favicon_chat_r2.ico';

        favicon(badge, eventForAccount());
        unread(0, eventForAccount());
        if (template) expect(mockSetTrayUnread).toHaveBeenLastCalledWith(false);
        else expect(mockGetIcon).toHaveBeenLastCalledWith('resources/icons/normal/16.png');
        favicon(badge, eventForAccount(2));
        favicon(normal, eventForAccount());
        unread(0, eventForAccount());
        if (template) expect(mockSetTrayUnread).toHaveBeenLastCalledWith(true);
        else expect(mockGetIcon).toHaveBeenLastCalledWith('resources/icons/badge/16.png');
        unread(7, eventForAccount(2));
        unread(0, eventForAccount(2));

        expect(mockSetBadgeCount).toHaveBeenLastCalledWith(0);
        if (template) expect(mockSetTrayUnread).toHaveBeenLastCalledWith(false);
        else {
          expect(mockGetIcon).toHaveBeenLastCalledWith('resources/icons/normal/16.png');
          expect(mockSetTrayUnread).not.toHaveBeenCalled();
          expect(tray.setImage).toHaveBeenLastCalledWith('/fake/icon.png');
        }
      }
    );

    it('deduplicates equal counts per account rather than across interleaved senders', async () => {
      const { setupBadgeHandlers } = await import('./badgeHelpers.js');
      setupBadgeHandlers(fakeWindow(), fakeTray());
      const unread = capturedHandler<number>('unreadCount');

      unread(60, eventForAccount());
      unread(60, eventForAccount(2));
      unread(60, eventForAccount());
      unread(0, eventForAccount(2));

      expect(mockSetBadgeCount.mock.calls).toEqual([[60], [99], [60]]);
      expect(mockSetTrayUnread).toHaveBeenLastCalledWith(true);
    });

    it('preserves cached counts across renderer destruction until permanent removal', async () => {
      const hooks = await import('../account/accountWebContentsHooks.js');
      const { setupBadgeHandlers } = await import('./badgeHelpers.js');
      setupBadgeHandlers(fakeWindow(), fakeTray());
      const unread = capturedHandler<number>('unreadCount');
      unread(5, eventForAccount());
      unread(7, eventForAccount(2));

      hooks.notifyAccountWebContentsDestroyed(asAccountIndex(2));
      unread(0, eventForAccount());
      unread(0, eventForAccount(2));
      expect(mockSetBadgeCount).toHaveBeenLastCalledWith(7);
      expect(mockSetTrayUnread).toHaveBeenLastCalledWith(true);
      hooks.notifyAccountRemoved(asAccountIndex(2));

      expect(mockSetBadgeCount).toHaveBeenLastCalledWith(0);
      expect(mockSetTrayUnread).toHaveBeenLastCalledWith(false);
    });

    it('accepts the replacement before the old disposer and rejects stale or destroyed identities', async () => {
      const hooks = await import('../account/accountWebContentsHooks.js');
      const { setupBadgeHandlers } = await import('./badgeHelpers.js');
      setupBadgeHandlers(fakeWindow(), fakeTray());
      const unread = capturedHandler<number>('unreadCount');
      const oldEvent = eventForAccount(2);
      unread(7, oldEvent);
      const replacement = asType<Electron.WebContents>({
        id: oldEvent.sender.id,
        isDestroyed: () => false,
      });
      liveWebContents.set(asAccountIndex(2), replacement);
      mockResolveAccount.mockReturnValue(asAccountIndex(2));
      hooks.notifyAccountWebContentsCreated({
        accountIndex: asAccountIndex(2),
        webContents: replacement,
        backend: 'browser-window',
      });

      unread(9, eventForAccount(2));
      unread(0, oldEvent);
      unread(0, asType<IpcMainEvent>({ sender: { id: replacement.id, isDestroyed: () => false } }));
      vi.spyOn(replacement, 'isDestroyed').mockReturnValue(true);
      unread(0, eventForAccount(2));

      expect(mockSetBadgeCount.mock.calls).toEqual([[7], [9]]);
      expect(mockSetTrayUnread).toHaveBeenLastCalledWith(true);
    });

    it('discards count and favicon caches on removal so recreation starts with unknown count', async () => {
      const hooks = await import('../account/accountWebContentsHooks.js');
      const { setupBadgeHandlers } = await import('./badgeHelpers.js');
      setupBadgeHandlers(fakeWindow(), fakeTray());
      const favicon = capturedHandler<string>('faviconChanged');
      const unread = capturedHandler<number>('unreadCount');
      const badge = 'https://mail.google.com/favicon_chat_new_notif_r2.ico';
      favicon(badge, eventForAccount(2));
      unread(0, eventForAccount(2));
      hooks.notifyAccountRemoved(asAccountIndex(2));
      liveWebContents.set(
        asAccountIndex(2),
        asType<Electron.WebContents>({ id: 103, isDestroyed: () => false })
      );
      hooks.notifyAccountWebContentsCreated({
        accountIndex: asAccountIndex(2),
        webContents: eventForAccount(2).sender,
        backend: 'browser-window',
      });

      favicon(badge, eventForAccount(2));

      expect(mockSetTrayUnread).toHaveBeenLastCalledWith(true);
      expect(mockSetBadgeCount).toHaveBeenLastCalledWith(0);
    });

    it('uses normal and offline typed-image fallbacks from all remaining accounts', async () => {
      mockPlatformState.useTemplateTrayIcon = false;
      const hooks = await import('../account/accountWebContentsHooks.js');
      const { setupBadgeHandlers } = await import('./badgeHelpers.js');
      setupBadgeHandlers(fakeWindow(), fakeTray());
      const favicon = capturedHandler<string>('faviconChanged');
      favicon('https://mail.google.com/favicon_chat_r2.ico', eventForAccount());
      favicon('https://example.com/offline.ico', eventForAccount(2));
      expect(mockGetIcon).toHaveBeenLastCalledWith('resources/icons/normal/16.png');

      hooks.notifyAccountRemoved(asAccountIndex(0));

      expect(mockGetIcon).toHaveBeenLastCalledWith('resources/icons/offline/16.png');
      expect(mockSetBadgeCount).toHaveBeenLastCalledWith(0);
    });

    it('invalidates captured IPC and hook callbacks when the session is cleaned', async () => {
      const hooks = await import('../account/accountWebContentsHooks.js');
      const { setupBadgeHandlers } = await import('./badgeHelpers.js');
      const cleanups = setupBadgeHandlers(fakeWindow(), fakeTray());
      const unread = capturedHandler<number>('unreadCount');
      unread(8, eventForAccount(2));

      cleanups.sessionCleanup();
      cleanups.sessionCleanup();
      mockSetBadgeCount.mockClear();
      mockSetTrayUnread.mockClear();
      hooks.notifyAccountWebContentsCreated({
        accountIndex: asAccountIndex(2),
        webContents: eventForAccount(2).sender,
        backend: 'browser-window',
      });
      unread(12, eventForAccount(2));
      hooks.notifyAccountRemoved(asAccountIndex(2));

      expect(mockSetBadgeCount).not.toHaveBeenCalled();
      expect(mockSetTrayUnread).not.toHaveBeenCalled();
    });
  });
});

// ─── Burst regression test (real ipcFastPath + ipcMain.on) ───────────────────
// Asserts that two/many rapid identical payloads collapse to a single
// downstream handler invocation via the inline last-value cache.
describe('badgeHelpers (burst regression with real ipcFastPath)', () => {
  beforeEach(async () => {
    vi.resetModules();
    mockSetBadgeCount.mockClear();
    mockSetTrayUnread.mockClear();
    mockShowNativeNotification.mockClear();
    mockConfigGet.mockReturnValue(false);
    mockPlatformState.supportsDockBadge = true;
    mockPlatformState.useTemplateTrayIcon = true;
    await backfillLiveAccounts();
    const { getRateLimiter } = await import('../ipc/rateLimiter.js');
    getRateLimiter().resetAll();
  });

  it('collapses 2 rapid identical UNREAD_COUNT payloads into 1 downstream call', async () => {
    const { ipcMain } = await import('electron');
    const { setupBadgeHandlers } = await import('./badgeHelpers.js');

    setupBadgeHandlers(fakeWindow(), fakeTray());

    // The most recently registered ipcMain.on call corresponds to UNREAD_COUNT
    // (FAVICON_CHANGED is registered first, UNREAD_COUNT second).
    const onMock = ipcMain.on as unknown as ReturnType<typeof vi.fn>;
    const unreadCall = onMock.mock.calls.find(([ch]) => ch === 'unreadCount');
    expect(unreadCall).toBeDefined();
    const unreadHandler = unreadCall![1] as (e: IpcMainEvent, d: unknown) => void;

    const event = eventForAccount();
    unreadHandler(event, 3);
    unreadHandler(event, 3);
    await new Promise((r) => setImmediate(r));

    // Only ONE downstream invocation despite two events
    expect(mockSetBadgeCount).toHaveBeenCalledTimes(1);
    expect(mockSetBadgeCount).toHaveBeenCalledWith(3);
  });

  it('does NOT deduplicate UNREAD_COUNT payloads with different values', async () => {
    const { ipcMain } = await import('electron');
    const { setupBadgeHandlers } = await import('./badgeHelpers.js');

    setupBadgeHandlers(fakeWindow(), fakeTray());
    const onMock = ipcMain.on as unknown as ReturnType<typeof vi.fn>;
    const unreadCall = onMock.mock.calls.find(([ch]) => ch === 'unreadCount');
    const unreadHandler = unreadCall![1] as (e: IpcMainEvent, d: unknown) => void;

    const event = eventForAccount();
    // Different payloads → different dedup keys → both should execute.
    unreadHandler(event, 1);
    unreadHandler(event, 2);
    await new Promise((r) => setImmediate(r));

    expect(mockSetBadgeCount).toHaveBeenCalledTimes(2);
    expect(mockSetBadgeCount).toHaveBeenNthCalledWith(1, 1);
    expect(mockSetBadgeCount).toHaveBeenNthCalledWith(2, 2);
  });

  it('collapses rapid identical FAVICON_CHANGED payloads into 1 downstream call', async () => {
    const { ipcMain } = await import('electron');
    const { setupBadgeHandlers } = await import('./badgeHelpers.js');

    const { getRateLimiter } = await import('../ipc/rateLimiter.js');
    getRateLimiter().resetAll();
    setupBadgeHandlers(fakeWindow(), fakeTray());

    const onMock = ipcMain.on as unknown as ReturnType<typeof vi.fn>;
    const faviconCall = onMock.mock.calls.find(([ch]) => ch === 'faviconChanged');
    expect(faviconCall).toBeDefined();
    const faviconHandler = faviconCall![1] as (e: IpcMainEvent, d: unknown) => void;

    const event = eventForAccount();
    faviconHandler(event, 'https://example.com/x.ico');
    faviconHandler(event, 'https://example.com/x.ico');
    await new Promise((r) => setImmediate(r));

    // setTrayUnread runs inside the handler body — should be called once
    expect(mockSetTrayUnread).toHaveBeenCalledTimes(1);
  });
});
