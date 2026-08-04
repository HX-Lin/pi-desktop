/**
 * niri (Linux translucent) theme settings.
 *
 * The theme uses two CSS custom properties on <html>:
 *  - --niri-bg-alpha:    main background opacity (0.5–1, wallpaper shows through)
 *  - --niri-panel-alpha: panel opacity (derived, always a bit more translucent
 *                        than the main background for depth)
 * and an optional .niri-glow-off class that disables the ambient accent glow.
 */

export interface NiriSettings {
  /** Background opacity 0.5..1 (1 = fully opaque). */
  opacity: number;
  /** Ambient accent glow behind the panels. */
  glow: boolean;
}

const OPACITY_KEY = "pi-niri-opacity";
const GLOW_KEY = "pi-niri-glow";
export const NIRI_OPACITY_MIN = 0.3;
export const NIRI_OPACITY_MAX = 1;
export const NIRI_OPACITY_DEFAULT = 0.7;

export function loadNiriSettings(): NiriSettings {
  let opacity = NIRI_OPACITY_DEFAULT;
  let glow = true;
  try {
    const raw = localStorage.getItem(OPACITY_KEY);
    if (raw) {
      const value = Number(raw);
      if (Number.isFinite(value)) {
        opacity = Math.min(NIRI_OPACITY_MAX, Math.max(NIRI_OPACITY_MIN, value));
      }
    }
    if (localStorage.getItem(GLOW_KEY) === "0") glow = false;
  } catch {
    // Storage unavailable — keep defaults.
  }
  return { opacity, glow };
}

export function applyNiriSettings(settings: NiriSettings): void {
  const root = document.documentElement;
  // Panels track the background linearly (no knee point) so dragging the
  // opacity slider feels even: panel ≈ 0.88 × background, floored for
  // readability. Readability itself comes from bright text + soft shadow.
  const panelAlpha = Math.max(settings.opacity * 0.88, 0.38);
  root.style.setProperty("--niri-bg-alpha", String(settings.opacity));
  root.style.setProperty("--niri-panel-alpha", String(panelAlpha));
  root.classList.toggle("niri-glow-off", !settings.glow);
}

export function saveNiriSettings(settings: NiriSettings): void {
  try {
    localStorage.setItem(OPACITY_KEY, String(settings.opacity));
    localStorage.setItem(GLOW_KEY, settings.glow ? "1" : "0");
  } catch {
    // Ignore storage errors.
  }
  applyNiriSettings(settings);
}
