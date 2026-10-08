// https://github.com/jiahaog/nativefier/blob/cf11a71a7c6efd366266fcf39ac6fc49783dd8c7/app/src/preload.ts#L23
import { ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/constants.js';
import { validateNotificationData } from '../shared/dataValidators.js';
import { asUnsafe } from '../shared/typeUtils.js';

// This feature requires contextIsolation to be disabled on BrowserWindow
// When contextIsolation is enabled, we can not override any global (window.X) API

const NativeNotification = window.Notification;

// Store notification instances to handle clicks
const notificationInstances = new Map<
  string,
  {
    onclick: ((this: Notification, ev: Event) => unknown) | null;
  }
>();
let notificationIdCounter = 0;

// Mock notification class that sends data to main process
class MockNotification extends EventTarget {
  public title: string;
  public body: string;
  public icon: string;
  public tag: string;
  public data: unknown;
  public dir: NotificationDirection;
  public lang: string;
  public badge: string;
  public requireInteraction: boolean;
  public silent: boolean | null;

  private _id: string;

  public onclick: ((this: Notification, ev: Event) => unknown) | null = null;
  public onclose: ((this: Notification, ev: Event) => unknown) | null = null;
  public onerror: ((this: Notification, ev: Event) => unknown) | null = null;
  public onshow: ((this: Notification, ev: Event) => unknown) | null = null;

  constructor(title: string, options?: NotificationOptions) {
    super();

    this.title = title;
    this.body = options?.body || '';
    this.icon = options?.icon || '';
    this.tag = options?.tag || `notification-${notificationIdCounter++}`;
    this.data = options?.data;
    this.dir = options?.dir || 'auto';
    this.lang = options?.lang || '';
    this.badge = options?.badge || '';
    this.requireInteraction = options?.requireInteraction || false;
    this.silent = options?.silent || null;

    this._id = this.tag;

    // Store this instance for click handling
    notificationInstances.set(this._id, { onclick: this.onclick });

    // Defense-in-depth: validate before sending to main process.
    // Main-side handler also validates via defineIPC,
    // but preload-side validation catches bad data early — especially
    // important since this script runs with contextIsolation: false.
    const notificationData = {
      title: this.title,
      body: this.body,
      icon: this.icon,
      tag: this.tag,
    };

    try {
      validateNotificationData(notificationData);
      ipcRenderer.send(IPC_CHANNELS.NOTIFICATION_SHOW, notificationData);
    } catch (error: unknown) {
      console.error('[overrideNotifications] Invalid notification data:', error);
      return;
    }

    // Simulate show event
    setTimeout(() => {
      if (this.onshow) {
        this.onshow.call(this, new Event('show'));
      }
    }, 0);
  }

  close(): void {
    // Clean up
    notificationInstances.delete(this._id);

    if (this.onclose) {
      this.onclose.call(this, new Event('close'));
    }
  }
}

// Listen for clicks from main process
ipcRenderer.on(IPC_CHANNELS.NOTIFICATION_CLICKED, () => {
  // Trigger click callback for all notifications
  notificationInstances.forEach((instance) => {
    if (instance.onclick) {
      instance.onclick.call(
        asUnsafe<Notification>(
          null,
          'Notification mock bridge for sandboxed preload (contextIsolation:false)'
        ),
        new Event('click')
      );
    }
  });
});

// Note: this must be the good old ES5 function,
// Dont convert this into an ES6 arrow function
const newNotify = function (title: string, options?: NotificationOptions) {
  return new MockNotification(title, options);
};

newNotify.requestPermission = NativeNotification.requestPermission.bind(NativeNotification);

Object.defineProperty(newNotify, 'permission', {
  get: () => NativeNotification.permission,
});

window.Notification = asUnsafe<typeof Notification>(
  newNotify,
  'Notification mock bridge for sandboxed preload (contextIsolation:false)'
);
