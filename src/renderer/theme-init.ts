// Apply the persisted theme before React mounts without requiring inline script CSP.
try {
  const theme = localStorage.getItem("pi-theme");
  if (theme === "dark") document.documentElement.classList.add("dark");
} catch {
  // Storage can be unavailable in privacy-restricted renderer contexts.
}

// Linux windows are created transparent so the wallpaper glows through.
// Flag it for CSS: translucent panels instead of an opaque base.
try {
  if (window.piBridge?.platform === "linux") {
    document.documentElement.classList.add("transparent-window");
  }
} catch {
  // Ignore when the preload bridge is unavailable (plain browser preview).
}
