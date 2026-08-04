// Apply the persisted theme before React mounts without requiring inline script CSP.
try {
  const theme = localStorage.getItem("pi-theme");
  if (theme === "dark") {
    document.documentElement.classList.add("dark");
  } else if (theme === "niri") {
    // niri builds on the dark palette; translucent variables override it.
    const root = document.documentElement;
    root.classList.add("dark", "niri");
    // Apply tunable opacity/glow synchronously before first paint.
    let opacity = 0.7;
    const raw = localStorage.getItem("pi-niri-opacity");
    if (raw) {
      const value = Number(raw);
      if (Number.isFinite(value)) opacity = Math.min(1, Math.max(0.3, value));
    }
    root.style.setProperty("--niri-bg-alpha", String(opacity));
    root.style.setProperty("--niri-panel-alpha", String(Math.max(opacity * 0.88, 0.38)));
    if (localStorage.getItem("pi-niri-glow") === "0") root.classList.add("niri-glow-off");
  }
} catch {
  // Storage can be unavailable in privacy-restricted renderer contexts.
}
