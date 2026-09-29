import type { CSSProperties, SVGProps } from 'react';
import { Computer, ICON_STROKE, Laptop, Monitor, PcCase, Server, type AppIcon } from './ui/icons';
import type { MachineKind } from '../services/machineIdentity';

// Hugeicons has no Mac mini or Mac Studio, so these two are drawn on its grid (24 units, the app's stroke, round joins).
// Adapted from T3 Code's apps/web/src/components/EnvironmentMachineIcon.tsx.
function GridIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    />
  );
}

/** A squat rounded slab with a light on its front edge. */
function MacMiniIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <GridIcon {...props}>
      <rect width="20" height="8" x="2" y="8" rx="3" />
      <path d="M6 12h.01" />
    </GridIcon>
  );
}

/** The same slab twice as tall, with ports along its front. */
function MacStudioIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <GridIcon {...props}>
      <rect width="18" height="14" x="3" y="5" rx="3" />
      <path d="M7 15h.01M11 15h.01M15 15h.01" />
    </GridIcon>
  );
}

const ICONS: Record<MachineKind, AppIcon | typeof MacMiniIcon> = {
  laptop: Laptop,
  macMini: MacMiniIcon,
  macStudio: MacStudioIcon,
  imac: Monitor,
  macPro: PcCase,
  mac: Computer,
  server: Server,
};

/**
 * A machine's shape; a server until it's known to be a Mac. Decorative: its name is always written beside it. Marked
 * as a machine's icon, which a neutral machine pill colors.
 */
export function MachineIcon({ kind, className, style }: { kind: MachineKind | null | undefined; className?: string; style?: CSSProperties }) {
  const Icon = ICONS[kind ?? 'server'];
  return <Icon className={className} style={style} aria-hidden="true" data-kind={kind ?? 'server'} data-machine-icon="" />;
}
