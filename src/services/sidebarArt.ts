import type { MessageKey } from '../i18n/resources';
import type { AppTheme } from '../theme';
import type { AppColor } from './appColor';
import { sceneTitleShade, type SceneName } from './sidebarScenes';

/** The artwork behind the sidebar's title row, chosen in Settings › Appearance: one of the scenes, or `off` for none. */
export type SidebarArt = SceneName | 'off';

/** In the order Appearance lists them. */
export const SIDEBAR_ARTS: readonly SidebarArt[] = ['aurora', 'canopy', 'off'];

/**
 * The leaf canopy, arbor.onl's own imagery, the default since 28 Sep 2026 (Aurora before). The earlier
 * artworks (Night and day, Wild country, Sprouting, Fern, Tree rings, Dusk canopy, then Fields, Treeline, Meadow and
 * Contours) come back as this too.
 */
export const DEFAULT_SIDEBAR_ART: SidebarArt = 'canopy';

export const SIDEBAR_ART_LABEL: Record<SidebarArt, MessageKey> = {
  aurora: 'appearance.sidebarArt.aurora',
  canopy: 'appearance.sidebarArt.canopy',
  off: 'appearance.sidebarArt.off',
};

export const isSidebarArt = (value: unknown): value is SidebarArt => SIDEBAR_ARTS.includes(value as SidebarArt);

/**
 * The saved choice, or the default for anything else (an artwork since removed, damaged storage). Leaves, removed
 * when Canopy took its leaves, opens as Canopy.
 */
export const sidebarArtChoice = (value: unknown): SidebarArt => (isSidebarArt(value) ? value : value === 'leaves' ? 'canopy' : DEFAULT_SIDEBAR_ART);

/** How the artwork moves while Arbor is in front: at its own pace, at a fifth of it, or not at all. */
export type SidebarArtMotion = 'moving' | 'slow' | 'still';
export const SIDEBAR_ART_MOTIONS: readonly SidebarArtMotion[] = ['moving', 'slow', 'still'];
export const DEFAULT_SIDEBAR_ART_MOTION: SidebarArtMotion = 'moving';
/** How far a scene's clock moves for each second, in each. */
export const SIDEBAR_ART_SPEED: Record<SidebarArtMotion, number> = { moving: 1, slow: 0.2, still: 0 };
export const SIDEBAR_ART_MOTION_LABEL: Record<SidebarArtMotion, MessageKey> = {
  moving: 'appearance.sidebarArtMotion.moving',
  slow: 'appearance.sidebarArtMotion.slow',
  still: 'appearance.sidebarArtMotion.still',
};
export const isSidebarArtMotion = (value: unknown): value is SidebarArtMotion => SIDEBAR_ART_MOTIONS.includes(value as SidebarArtMotion);
export const sidebarArtMotionChoice = (value: unknown): SidebarArtMotion => (isSidebarArtMotion(value) ? value : DEFAULT_SIDEBAR_ART_MOTION);

/**
 * The color the wordmark and the sidebar button take over a scene, in each theme. The scene runs at full strength
 * behind them, so they carry a halo in the color under it (styles.css `art-halo`): the sidebar's own, or the deep shade
 * a scene lays under the title row (the light canopy's), where they go light. The ink clears 4.5:1 against that, which
 * tests/sidebarArt.test.tsx checks. With no artwork they keep the sidebar's own colors.
 */
const INK: Record<AppTheme, string> = { light: '#27272a', dark: '#f5f5f5' };
const ON_SHADE_INK = '#f5f5f5';
const hex = (rgb: readonly number[]) => `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;

export const sidebarArtInk = (art: SidebarArt, theme: AppTheme, color: AppColor): string | undefined =>
  art === 'off' ? undefined : sceneTitleShade(art, theme, color) ? ON_SHADE_INK : INK[theme];
/** The halo's color where a scene lays its shade under the title row (in Arbor's color); otherwise the sidebar's. */
export const sidebarArtHalo = (art: SidebarArt, theme: AppTheme, color: AppColor): string | undefined => {
  const shade = art === 'off' ? undefined : sceneTitleShade(art, theme, color);
  return shade && hex(shade);
};
