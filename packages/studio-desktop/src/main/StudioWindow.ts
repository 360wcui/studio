// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  Menu,
  MenuItem,
  MenuItemConstructorOptions,
  TitleBarOverlayOptions,
  app,
  nativeTheme,
  shell,
  systemPreferences,
} from "electron";
import path from "path";

import Logger from "@foxglove/log";
import { APP_BAR_HEIGHT } from "@foxglove/studio-base/src/components/AppBar/constants";
import { NativeAppMenuEvent } from "@foxglove/studio-base/src/context/NativeAppMenuContext";
import * as palette from "@foxglove/studio-base/src/theme/palette";

import StudioAppUpdater from "./StudioAppUpdater";
import getDevModeIcon from "./getDevModeIcon";
import { simulateUserClick } from "./simulateUserClick";
import { getTelemetrySettings } from "./telemetry";
import { encodeRendererArg } from "../common/rendererArgs";
import { FOXGLOVE_PRODUCT_NAME } from "../common/webpackDefines";

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;

const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";
const isWindows = process.platform === "win32";
const isProduction = process.env.NODE_ENV === "production";
const rendererPath = MAIN_WINDOW_WEBPACK_ENTRY;

const closeMenuItem: MenuItemConstructorOptions = isMac ? { role: "close" } : { role: "quit" };
const log = Logger.getLogger(__filename);

type ClearableMenu = Menu & { clear: () => void };

function getWindowBackgroundColor(): string | undefined {
  const theme = palette[nativeTheme.shouldUseDarkColors ? "dark" : "light"];
  return theme.background?.default;
}

function getTitleBarOverlayOptions(): TitleBarOverlayOptions {
  const theme = palette[nativeTheme.shouldUseDarkColors ? "dark" : "light"];
  if (isWindows) {
    return {
      height: APP_BAR_HEIGHT,
      color: theme.appBar.main,
      symbolColor: theme.appBar.text,
    };
  }
  return {};
}

function newStudioWindow(deepLinks: string[] = [], reloadMainWindow: () => void): BrowserWindow {
  const { crashReportingEnabled, telemetryEnabled } = getTelemetrySettings();
  const preloadPath = path.join(app.getAppPath(), "main", "preload.js");

  const macTrafficLightInset =
    Math.floor((APP_BAR_HEIGHT - /*button size*/ 12) / 2) - /*for good measure*/ 1;

  const windowOptions: BrowserWindowConstructorOptions = {
    backgroundColor: getWindowBackgroundColor(),
    height: 800,
    width: 1200,
    minWidth: 350,
    minHeight: 250,
    autoHideMenuBar: true,
    title: FOXGLOVE_PRODUCT_NAME,
    frame: isLinux ? false : true,
    titleBarStyle: "hidden",
    trafficLightPosition: isMac ? { x: macTrafficLightInset, y: macTrafficLightInset } : undefined,
    titleBarOverlay: getTitleBarOverlayOptions(),
    webPreferences: {
      contextIsolation: true,
      sandbox: false, // Allow preload script to access Node builtins
      preload: preloadPath,
      nodeIntegration: false,
      additionalArguments: [
        `--allowCrashReporting=${crashReportingEnabled ? "1" : "0"}`,
        `--allowTelemetry=${telemetryEnabled ? "1" : "0"}`,
        encodeRendererArg("deepLinks", deepLinks),
      ],
      // Disable webSecurity in development so we can make XML-RPC calls, load
      // remote data, etc. In production, the app is served from file:// URLs so
      // the Origin header is not sent, disabling the CORS
      // Access-Control-Allow-Origin check
      webSecurity: isProduction,
    },
  };
  if (!isProduction) {
    const devIcon = getDevModeIcon();
    if (devIcon) {
      windowOptions.icon = devIcon;
    }
  }

  const browserWindow = new BrowserWindow(windowOptions);
  nativeTheme.on("updated", () => {
    if (isWindows) {
      // Although the TS types say this function is always available, it is undefined on non-Windows platforms
      browserWindow.setTitleBarOverlay(getTitleBarOverlayOptions());
    }
    const bgColor = getWindowBackgroundColor();
    if (bgColor != undefined) {
      browserWindow.setBackgroundColor(bgColor);
    }
  });

  // Forward full screen events to the renderer
  browserWindow.addListener("enter-full-screen", () =>
    browserWindow.webContents.send("enter-full-screen"),
  );
  browserWindow.addListener("leave-full-screen", () =>
    browserWindow.webContents.send("leave-full-screen"),
  );
  browserWindow.addListener("maximize", () => browserWindow.webContents.send("maximize"));

  browserWindow.addListener("unmaximize", () => browserWindow.webContents.send("unmaximize"));

  browserWindow.webContents.once("dom-ready", () => {
    if (!isProduction) {
      browserWindow.webContents.openDevTools();
    }
    browserWindow.webContents.send(browserWindow.isMaximized() ? "maximize" : "unmaximize");
  });

  // Open all new windows in an external browser
  browserWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  browserWindow.webContents.on("will-navigate", (event, reqUrl) => {
    // if the target url is not the same as our host then force open in a browser
    // URL.host includes the port - so this works for localhost servers vs webpack dev server
    const targetHost = new URL(reqUrl).host;
    const currentHost = new URL(browserWindow.webContents.getURL()).host;
    const isExternal = targetHost !== currentHost;
    if (isExternal) {
      event.preventDefault();
      void shell.openExternal(reqUrl);
    }
  });

  browserWindow.webContents.on("ipc-message", (_event, channel) => {
    switch (channel) {
      case "titleBarDoubleClicked": {
        const action: string =
          // Although the TS types say this function is always available, it is undefined on non-Mac platforms
          (isMac && systemPreferences.getUserDefault("AppleActionOnDoubleClick", "string")) ||
          "Maximize";
        if (action === "Minimize") {
          browserWindow.minimize();
        } else if (action === "Maximize") {
          if (browserWindow.isMaximized()) {
            browserWindow.unmaximize();
          } else {
            browserWindow.maximize();
          }
        } else {
          // "None"
        }
        break;
      }
      case "minimizeWindow":
        browserWindow.minimize();
        break;
      case "maximizeWindow":
        browserWindow.maximize();
        break;
      case "unmaximizeWindow":
        browserWindow.unmaximize();
        break;
      case "closeWindow":
        browserWindow.close();
        break;
      case "reloadMainWindow":
        log.info("reloading main window");
        reloadMainWindow();
        break;
      default:
        break;
    }
  });

  return browserWindow;
}

function sendNativeAppMenuEvent(event: NativeAppMenuEvent, browserWindow: BrowserWindow) {
  browserWindow.webContents.send(event);
}

function buildMenu(browserWindow: BrowserWindow): Menu {
  const menuTemplate: MenuItemConstructorOptions[] = [];

  const checkForUpdatesItem: MenuItemConstructorOptions = {
    label: "Check for Updates…",
    click: () => void StudioAppUpdater.Instance().checkNow(),
    enabled: StudioAppUpdater.Instance().canCheckForUpdates(),
  };

  if (isMac) {
    menuTemplate.push({
      role: "appMenu",
      label: app.name,
      submenu: [
        { role: "about" },
        checkForUpdatesItem,
        { type: "separator" },
        {
          label: "Settings…",
          accelerator: "CommandOrControl+,",
          click: () => sendNativeAppMenuEvent("open-help-general", browserWindow),
        },
        { role: "services" },
        { type: "separator" },

        { type: "separator" },

        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { role: "quit" },
      ],
    });
  }

  menuTemplate.push({
    role: "fileMenu",
    label: "File",
    id: "fileMenu",
    submenu: [
      {
        label: "New Window",
        click: () => {
          new StudioWindow().load();
        },
      },
      { type: "separator" },
      closeMenuItem,
    ],
  });

  menuTemplate.push({
    role: "editMenu",
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },

      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      ...(isMac
        ? [
            { role: "pasteAndMatchStyle" } as const,
            { role: "delete" } as const,
            { role: "selectAll" } as const,
          ]
        : [
            { role: "delete" } as const,
            { type: "separator" } as const,
            { role: "selectAll" } as const,
          ]),
    ],
  });

  const showSharedWorkersMenu = () => {
    // Electron doesn't let us update dynamic menus when they are being opened, so just open a popup
    // context menu. This is ugly, but only for development anyway.
    // https://github.com/electron/electron/issues/528
    const workers = browserWindow.webContents.getAllSharedWorkers();
    Menu.buildFromTemplate(
      workers.length === 0
        ? [{ label: "No Shared Workers", enabled: false }]
        : workers.map(
            (worker) =>
              new MenuItem({
                label: worker.url,
                click() {
                  browserWindow.webContents.closeDevTools();
                  browserWindow.webContents.inspectSharedWorkerById(worker.id);
                },
              }),
          ),
    ).popup();
  };

  menuTemplate.push({
    role: "viewMenu",
    label: "View",
    submenu: [
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
      { type: "separator" },
      {
        label: "Advanced",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          {
            label: "Inspect Shared Worker…",
            click() {
              showSharedWorkersMenu();
            },
          },
        ],
      },
    ],
  });

  menuTemplate.push({
    role: "help",
    submenu: [
      {
        label: "About",
        click: () => sendNativeAppMenuEvent("open-help-about", browserWindow),
      },
      {
        label: "View our docs",
        click: () => sendNativeAppMenuEvent("open-help-docs", browserWindow),
      },
      {
        label: "Join our Slack",
        click: () => sendNativeAppMenuEvent("open-help-slack", browserWindow),
      },
      { type: "separator" },
      {
        label: "Explore sample data",
        click: async () => {
          await simulateUserClick(browserWindow);
          sendNativeAppMenuEvent("open-demo", browserWindow);
        },
      },
    ],
  });

  return Menu.buildFromTemplate(menuTemplate);
}

class StudioWindow {
  // track windows by the web-contents id
  // The web contents id is most broadly available across IPC events and app handlers
  // BrowserWindow.id is not as available
  static #windowsByContentId = new Map<number, StudioWindow>();
  readonly #deepLinks: string[];
  readonly #inputSources = new Set<string>();

  #browserWindow: BrowserWindow;
  #menu: Menu;

  public constructor(deepLinks: string[] = []) {
    this.#deepLinks = deepLinks;

    const [newWindow, newMenu] = this.#buildBrowserWindow();
    this.#browserWindow = newWindow;
    this.#menu = newMenu;
  }

  public load(): void {
    // load after setting windowsById so any ipc handlers with id lookup work
    log.info(`window.loadURL(${rendererPath})`);
    this.#browserWindow
      .loadURL(rendererPath)
      .then(() => {
        log.info("window URL loaded");
      })
      .catch((err) => {
        log.error("loadURL error", err);
      });
  }

  public addInputSource(name: string): void {
    // A "Foxglove Data Platform" connection is triggered by opening a URL from console
    // Not currently a connection that can be started from inside Foxglove Studio
    const unsupportedInputSourceNames = ["Foxglove Data Platform"];
    if (unsupportedInputSourceNames.includes(name)) {
      return;
    }

    this.#inputSources.add(name);

    const fileMenu = this.#menu.getMenuItemById("fileMenu");
    if (!fileMenu) {
      return;
    }

    const existingItem = fileMenu.submenu?.getMenuItemById(name);
    // If the item already exists, we can silently return
    // The existing click handler will support the new item since they have the same name
    if (existingItem) {
      existingItem.visible = true;
      return;
    }

    // build new file menu
    this.#rebuildFileMenu(fileMenu);

    this.#browserWindow.setMenu(this.#menu);
  }

  public removeInputSource(name: string): void {
    this.#inputSources.delete(name);

    const fileMenu = this.#menu.getMenuItemById("fileMenu");
    if (!fileMenu) {
      return;
    }

    this.#rebuildFileMenu(fileMenu);
    this.#browserWindow.setMenu(this.#menu);
  }

  public getBrowserWindow(): BrowserWindow {
    return this.#browserWindow;
  }

  public getMenu(): Menu {
    return this.#menu;
  }

  public static fromWebContentsId(id: number): StudioWindow | undefined {
    return StudioWindow.#windowsByContentId.get(id);
  }

  #sendNativeAppMenuEvent(event: NativeAppMenuEvent) {
    this.#browserWindow.webContents.send(event);
  }

  #reloadMainWindow(): void {
    const windowWasMaximized = this.#browserWindow.isMaximized();
    this.#browserWindow.close();
    this.#browserWindow.destroy();

    const [newWindow, newMenu] = this.#buildBrowserWindow();
    this.#browserWindow = newWindow;
    this.#menu = newMenu;
    this.load();

    if (windowWasMaximized) {
      this.#browserWindow.maximize();
    }
  }

  #buildBrowserWindow(): [BrowserWindow, Menu] {
    const browserWindow = newStudioWindow(this.#deepLinks, () => {
      this.#reloadMainWindow();
    });
    const newMenu = buildMenu(browserWindow);
    const id = browserWindow.webContents.id;

    log.info(`New Foxglove Studio window ${id}`);
    StudioWindow.#windowsByContentId.set(id, this);

    // when a window closes and it is the current application menu, clear the input sources
    browserWindow.once("close", () => {
      if (Menu.getApplicationMenu() === this.#menu) {
        const existingMenu = Menu.getApplicationMenu();
        const fileMenu = existingMenu?.getMenuItemById("fileMenu");
        // https://github.com/electron/electron/issues/8598
        (fileMenu?.submenu as undefined | ClearableMenu)?.clear();
        fileMenu?.submenu?.append(
          new MenuItem({
            label: "New Window",
            click: () => {
              new StudioWindow().load();
            },
          }),
        );

        fileMenu?.submenu?.append(
          new MenuItem({
            type: "separator",
          }),
        );

        fileMenu?.submenu?.append(new MenuItem(closeMenuItem));
        Menu.setApplicationMenu(existingMenu);
      }
    });
    browserWindow.once("closed", () => {
      StudioWindow.#windowsByContentId.delete(id);
    });

    return [browserWindow, newMenu];
  }

  #rebuildFileMenu(fileMenu: MenuItem): void {
    const browserWindow = this.#browserWindow;

    // https://github.com/electron/electron/issues/8598
    (fileMenu.submenu as ClearableMenu).clear();
    fileMenu.submenu?.items.splice(0, fileMenu.submenu.items.length);

    fileMenu.submenu?.append(
      new MenuItem({
        label: "New Window",
        click: () => {
          new StudioWindow().load();
        },
      }),
    );

    fileMenu.submenu?.append(
      new MenuItem({
        type: "separator",
      }),
    );

    fileMenu.submenu?.append(
      new MenuItem({
        label: "Open…",
        click: async () => {
          await simulateUserClick(browserWindow);
          this.#sendNativeAppMenuEvent("open");
        },
      }),
    );

    fileMenu.submenu?.append(
      new MenuItem({
        label: "Open local file…",
        click: async () => {
          await simulateUserClick(browserWindow);
          this.#sendNativeAppMenuEvent("open-file");
        },
      }),
    );

    fileMenu.submenu?.append(
      new MenuItem({
        label: "Open connection...",
        click: async () => {
          await simulateUserClick(browserWindow);
          this.#sendNativeAppMenuEvent("open-connection");
        },
      }),
    );

    fileMenu.submenu?.append(
      new MenuItem({
        type: "separator",
      }),
    );

    fileMenu.submenu?.append(new MenuItem(closeMenuItem));
  }
}

export default StudioWindow;
