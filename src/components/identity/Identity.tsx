import { memo, type CSSProperties, type ReactNode } from 'react';
import { Monitor, TerminalSquare } from '../ui/icons';
import antigravityIcon from '../../assets/icons/antigravity.svg';
import claudeIcon from '../../assets/icons/claude.svg';
import codexIcon from '../../assets/icons/codex.svg';
import geminiIcon from '../../assets/icons/gemini.svg';
import grokIcon from '../../assets/icons/grok.svg';
import kimiIcon from '../../assets/icons/kimi-light.svg';
import vertexIcon from '../../assets/icons/vertex.svg';
import { useMachineKind } from '../../hooks/useMachineIdentities';
import { useI18n } from '../../i18n';
import { cn } from '../../lib/utils';
import { canonicalProvider } from '../../services/authFiles';
import { identityColorCss, identityColorIsLight } from '../../services/identityColors';
import { machineLookKey, resolveMachineLook, useMachineLookChoices } from '../../services/machineLook';
import { useMachineName } from '../../services/machineNames';
import { sessionClient } from '../../services/usageSessions';
import { MachineIcon } from '../MachineIcon';
import { Badge } from '../ui/badge';

/**
 * The marks that say which machine, provider or client something is, the same wherever it's named. A machine is its
 * pill: its color, shape and fill (Settings › Machines picks them); a provider or client is its brand's mark.
 */

const plainClass = 'inline-flex min-w-0 max-w-full items-center gap-1.5';

/** A machine's look: its color, icon and fill, from what was picked for it and what its model is. */
export function useMachineLook(name: string) {
  const choices = useMachineLookChoices();
  const kind = useMachineKind(name);
  return resolveMachineLook(name, choices[machineLookKey(name)], kind);
}

/**
 * The pill's three sizes: `sm` in a line of small print under a row's title, `md` in tables, lists and the sidebar,
 * `lg` where the machine is what a card or page is about.
 */
export type MachinePillSize = 'sm' | 'md' | 'lg';

const PILL_SIZE: Record<MachinePillSize, string> = {
  sm: 'h-[1.125rem] gap-1 rounded-[0.3125rem] px-1 text-2xs',
  md: 'h-5 gap-1 rounded-md px-1.5 text-xs',
  lg: 'h-6 gap-1.5 rounded-md px-2 text-sm',
};
/**
 * The icon's size, color and opacity sit on the icon itself: buttons, selects and badges size, tint and fade any icon
 * without its own `size-`, `text-` and `opacity-` classes, and a pill in a sentence can land inside any of them.
 */
const PILL_ICON: Record<MachinePillSize, string> = {
  sm: 'size-3 text-inherit opacity-100',
  md: 'size-3 text-inherit opacity-100',
  lg: 'size-3.5 text-inherit opacity-100',
};
// Sans even inside a monospace line (a confirmation's details, a path), so a machine always looks the same.
const pillClass = 'machine-pill inline-flex min-w-0 max-w-full items-center font-sans font-medium leading-none whitespace-nowrap align-middle';
const interactiveClass = 'cursor-pointer outline-none transition-shadow focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring';

type MachinePillProps = {
  name: string | null | undefined;
  size?: MachinePillSize;
  /** What it says when there's no machine (Unassigned, say): the same pill in gray. */
  fallback?: string;
  /** Makes it a button that opens something of the machine's; `label` names what for a screen reader. */
  onClick?: () => void;
  label?: string;
  className?: string;
};

/**
 * A machine as it's named everywhere in Arbor: its icon and name in a pill of its color, filled the way Settings ›
 * Machines says. Without a name it says `fallback` in the same pill, gray, with a plain icon. Memoized: rows name
 * their machines on every render, and the pill changes only with its own machine.
 */
export const MachinePill = memo(function MachinePill({ name, size = 'md', fallback, onClick, label, className }: MachinePillProps) {
  const machine = name?.trim();
  if (!machine) {
    const content = (
      <>
        <Monitor aria-hidden="true" data-machine-icon="" className={cn('shrink-0', PILL_ICON[size])} />
        <span className="truncate">{fallback}</span>
      </>
    );
    const style = { '--machine-color': 'var(--color-zinc-500)' } as CSSProperties;
    const classes = cn(pillClass, PILL_SIZE[size], 'text-muted-foreground!', onClick && interactiveClass, className);
    return onClick ? (
      <button type="button" className={classes} style={style} data-fill="neutral" data-interactive="" aria-label={label} onClick={onClick}>{content}</button>
    ) : (
      <span className={classes} style={style} data-fill="neutral">{content}</span>
    );
  }
  return <NamedMachine name={machine} size={size} onClick={onClick} label={label} className={className} />;
});

function NamedMachine({ name, size, onClick, label, className }: Omit<MachinePillProps, 'name' | 'fallback'> & { name: string; size: MachinePillSize }) {
  const look = useMachineLook(name);
  // The name it was given in Arbor, if any; hovering still shows the one keys, SSH and the setup repo know it by.
  const shown = useMachineName(name);
  const style = { '--machine-color': identityColorCss(look.color) } as CSSProperties;
  const attributes = {
    className: cn(pillClass, PILL_SIZE[size], onClick && interactiveClass, className),
    style,
    title: shown === name ? name : `${shown} (${name})`,
    'data-machine-color': look.color,
    'data-fill': look.fill,
    'data-ink': look.fill === 'solid' && identityColorIsLight(look.color) ? 'dark' : undefined,
  };
  const content = (
    <>
      <MachineIcon kind={look.icon} className={cn('shrink-0', PILL_ICON[size])} />
      <span className="truncate">{shown}</span>
    </>
  );
  return onClick ? (
    <button type="button" {...attributes} data-interactive="" aria-label={label} onClick={onClick}>{content}</button>
  ) : (
    <span {...attributes}>{content}</span>
  );
}

/**
 * Several machines, each with its pill, for a list in a sentence or a table cell ("on cam-mbp, cedar-02"). The
 * pills stand apart on their own, so no commas; they wrap on a narrow line.
 */
export function MachinePills({ names, size = 'sm', className }: { names: readonly string[]; size?: MachinePillSize; className?: string }) {
  return (
    <span className={cn('inline-flex max-w-full flex-wrap items-center gap-1 align-middle', className)}>
      {names.map((name) => <MachinePill key={name} name={name} size={size} />)}
    </span>
  );
}

/** A machine's icon in its color, for an icon box that writes its name beside it (the search palette). Decorative. */
export const MachineMark = memo(function MachineMark({ name, className }: { name: string; className?: string }) {
  const look = useMachineLook(name);
  return <MachineIcon kind={look.icon} className={cn('shrink-0', className)} style={{ color: identityColorCss(look.color) }} />;
});

const PROVIDERS: Record<string, { label: string; icon: string; tint?: boolean }> = {
  claude: { label: 'Claude', icon: claudeIcon },
  codex: { label: 'Codex', icon: codexIcon },
  gemini: { label: 'Gemini', icon: geminiIcon },
  vertex: { label: 'Vertex', icon: vertexIcon },
  // Drawn in currentColor, which an <img> reads as black: lightened in dark mode.
  kimi: { label: 'Kimi', icon: kimiIcon, tint: true },
  xai: { label: 'xAI', icon: grokIcon, tint: true },
  antigravity: { label: 'Antigravity', icon: antigravityIcon },
};

/** A provider's mark and name, or just the name it was given when Arbor has no mark for it. */
export function ProviderPill({ provider, className }: { provider: string; className?: string }) {
  const known = PROVIDERS[canonicalProvider(provider)];
  return (
    <span className={cn(plainClass, className)} title={known?.label ?? provider}>
      {known ? <img src={known.icon} alt="" className={cn('size-3.5 shrink-0', known.tint && 'dark:invert')} /> : null}
      <span className="truncate">{known?.label ?? provider}</span>
    </span>
  );
}

/**
 * Just a provider's mark, for a row that names something of the provider's, like a model. `fallback` (else nothing)
 * for one without. `decorative` where the provider is already named or labeled beside it, so it isn't read out twice.
 */
export function ProviderMark({ provider, decorative = false, fallback = null, className }: { provider: string; decorative?: boolean; fallback?: ReactNode; className?: string }) {
  const known = PROVIDERS[canonicalProvider(provider)];
  if (!known) return fallback;
  const label = decorative ? undefined : known.label;
  return <img src={known.icon} alt={label ?? ''} title={label} className={cn('size-3.5 shrink-0', known.tint && 'dark:invert', className)} />;
}

/**
 * The provider whose mark a model wears, read from its name, for rows that don't record which provider served it: a
 * session's models, the archive's, the price list's. A `vendor/` prefix (`anthropic/…`) counts when it names one.
 */
export function modelProvider(model: string): string | null {
  const name = model.trim().toLowerCase();
  const slash = name.indexOf('/');
  if (slash > 0) {
    const vendor = canonicalProvider(name.slice(0, slash));
    if (PROVIDERS[vendor]) return vendor;
  }
  const bare = name.slice(slash + 1);
  if (/^(claude|opus|sonnet|haiku|fable)\b/.test(bare)) return 'claude';
  if (/^(gpt|chatgpt|codex|o\d)\b/.test(bare)) return 'codex';
  if (/^gemini\b/.test(bare)) return 'gemini';
  if (/^grok\b/.test(bare)) return 'xai';
  if (/^kimi\b/.test(bare)) return 'kimi';
  return null;
}

/**
 * A model as Usage › Requests names it: its provider's mark, then the name without a leading `claude-` (the mark
 * already says so), then the reasoning effort in small print when there is one. The full name is its title.
 * `provider` is the one that served it when the row records it and Arbor has its mark; otherwise the name says.
 * Its name is medium and in the foreground color, which `className` can change (a menu's options are plain).
 */
export function ModelName({ model, provider, effort, className }: { model: string; provider?: string | null; effort?: string | null; className?: string }) {
  const served = canonicalProvider(provider ?? '');
  const mark = PROVIDERS[served] ? served : modelProvider(model);
  const shown = mark ? model.replace(/^claude-(?=.)/i, '') : model;
  return (
    <span className={cn(plainClass, 'font-medium text-foreground', className)} title={model}>
      {mark ? <ProviderMark provider={mark} /> : null}
      <span className="truncate">{shown}</span>
      {effort ? <small className="shrink-0 text-xs font-normal text-muted-foreground" title={effort}>{effort}</small> : null}
    </span>
  );
}

/** A session's or thread's models: the one it used most as a ModelName, then how many others, all of them in the title. */
export function ModelNames({ models, className }: { models: readonly string[]; className?: string }) {
  const { t } = useI18n();
  const [first] = models;
  if (!first) return <span className={cn('text-muted-foreground', className)}>—</span>;
  return (
    <span className={cn(plainClass, className)} title={models.join(', ')}>
      <ModelName model={first} className="min-w-0" />
      {models.length > 1 ? <Badge variant="secondary" className="shrink-0 tabular-nums">{t('usage.sessions.moreModels', { count: models.length - 1 })}</Badge> : null}
    </span>
  );
}

/** The mark for a client: Claude's for Claude Code and its SDK, Codex's for Codex, a terminal for anything else. */
function clientMark(name: string) {
  if (/claude/i.test(name)) return claudeIcon;
  if (/codex/i.test(name)) return codexIcon;
  return null;
}

/**
 * The client behind a request or session, from its User-Agent: its mark, its name, its version (unless `version` is
 * off) and what it ran in, like T3 Code. The raw User-Agent is its title.
 */
export function ClientPill({ userAgent, version = true, className }: { userAgent: string | null | undefined; version?: boolean; className?: string }) {
  const { t } = useI18n();
  const client = sessionClient(userAgent);
  if (!client) {
    return <span className={cn(plainClass, 'text-muted-foreground', className)}>{t('usage.sessions.unknownClient')}</span>;
  }
  const mark = clientMark(client.name);
  return (
    <span className={cn(plainClass, className)} title={userAgent ?? undefined}>
      {mark ? <img src={mark} alt="" className="size-3.5 shrink-0" /> : <TerminalSquare className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
      <span className="truncate">
        {client.name}
        {version && client.version ? <span className="ms-1 font-normal text-muted-foreground tabular-nums">{client.version}</span> : null}
        {client.host ? <span className="font-normal text-muted-foreground"> · {client.host}</span> : null}
      </span>
    </span>
  );
}

/** A client known only by its name, not a User-Agent (the archive tells Claude Code from Codex by where it found them). */
export function ClientName({ name, className }: { name: string; className?: string }) {
  const mark = clientMark(name);
  return (
    <span className={cn(plainClass, className)}>
      {mark ? <img src={mark} alt="" className="size-3.5 shrink-0" /> : <TerminalSquare className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
      <span className="truncate">{name}</span>
    </span>
  );
}
