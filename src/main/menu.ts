import { app, Menu, shell, type BrowserWindow } from "electron";

export function installAppMenu(getWindow: () => BrowserWindow | null, onCheckForUpdates?: () => void): void {
  const isMac = process.platform === "darwin";
  const isWindows = process.platform === "win32";

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              {
                label: "Check for Updates…",
                click: () => {
                  if (onCheckForUpdates) {
                    onCheckForUpdates();
                    return;
                  }
                  const win = getWindow();
                  win?.show();
                  win?.focus();
                  win?.webContents.send("menu:check-for-updates");
                },
              },
              { type: "separator" as const },
              {
                label: "Settings…",
                accelerator: "CmdOrCtrl+,",
                click: () => {
                  getWindow()?.webContents.send("menu:settings");
                },
              },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Session",
          // Ctrl+N conflicts with terminal navigation; keep Shift so the
          // embedded terminal receives the raw key.
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => {
            getWindow()?.webContents.send("menu:new-session");
          },
        },
        {
          label: "Switch Session…",
          // Ctrl+K is kill-to-end-of-line in shells.
          accelerator: "CmdOrCtrl+Shift+K",
          click: () => {
            getWindow()?.webContents.send("menu:switch-session");
          },
        },
        { type: "separator" },
        ...(isMac
          ? []
          : [
              {
                label: "Settings…",
                accelerator: "CmdOrCtrl+,",
                click: () => {
                  getWindow()?.webContents.send("menu:settings");
                },
              },
              { type: "separator" as const },
            ]),
        isMac ? { role: "close" as const } : { label: "Quit", click: () => app.quit() },
      ],
    },
    {
      label: "Edit",
      // No accelerators: Ctrl+C/V/X/A/Z must reach the embedded terminal
      // (SIGINT, paste, kill-word, …). The browser's built-in editing commands
      // still work inside ordinary inputs.
      submenu: [
        { label: "Undo", click: () => getWindow()?.webContents.undo() },
        { label: "Redo", click: () => getWindow()?.webContents.redo() },
        { type: "separator" },
        { label: "Cut", click: () => getWindow()?.webContents.cut() },
        { label: "Copy", click: () => getWindow()?.webContents.copy() },
        { label: "Paste", click: () => getWindow()?.webContents.paste() },
        { label: "Select All", click: () => getWindow()?.webContents.selectAll() },
      ],
    },
    {
      label: "View",
      submenu: [
        // Ctrl+R is reverse-history-search in shells; move reload off it.
        { label: "Reload", click: () => getWindow()?.webContents.reload() },
        { label: "Force Reload", click: () => getWindow()?.webContents.reloadIgnoringCache() },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { label: "Minimize", click: () => getWindow()?.minimize() },
        { role: "zoom" },
        ...(isMac
          ? [{ type: "separator" as const }, { role: "front" as const }]
          : [{ label: "Close", click: () => getWindow()?.close() }]),
      ],
    },
    {
      label: "Help",
      submenu: [
        ...(isWindows
          ? [
              {
                label: "Check for Updates…",
                click: () => {
                  if (onCheckForUpdates) {
                    onCheckForUpdates();
                    return;
                  }
                  const win = getWindow();
                  win?.show();
                  win?.focus();
                  win?.webContents.send("menu:check-for-updates");
                },
              },
              { type: "separator" as const },
            ]
          : []),
        {
          label: "Open Logs Folder",
          click: () => {
            void shell.openPath(app.getPath("logs"));
          },
        },
        {
          label: "Export Diagnostics…",
          click: () => {
            getWindow()?.webContents.send("menu:export-diagnostics");
          },
        },
        { type: "separator" },
        {
          label: "Learn More",
          click: () => {
            void shell.openExternal("https://github.com/DLYZZT/pi-desktop");
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
