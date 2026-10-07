import { useLayoutEffect, useRef, type CSSProperties } from 'react';
import { avatarCharacters, type ResolvedProfile } from '../services/accountProfiles';
import { identityColorCss, identityColorIsLight } from '../services/identityColors';
import { cn } from '../lib/utils';

type Size = 'xs' | 'sm' | 'md';

const box: Record<Size, string> = { xs: 'size-5', sm: 'size-6', md: 'size-8' };

/**
 * The label's size for one, two and three characters, from the type scale: two fill about half the box, three step
 * down and are fitted to it below.
 */
const labelSize: Record<Size, [string, string, string]> = {
  xs: ['text-2xs', 'text-3xs', 'text-3xs tracking-tight'],
  sm: ['text-xs', 'text-2xs', 'text-3xs tracking-tight'],
  md: ['text-base', 'text-sm', 'text-xs tracking-tight'],
};

/** The share of the box's width a label may take. A wider one (WWW, MW) is scaled down to it. */
const LABEL_ROOM = 0.76;

/**
 * An account's squircle in its color and fill, with its one to three character label: the one mark for an account
 * wherever it's named. xs (20px, a machine pill's height) in rows and tables, sm (24px) in the Accounts page's lists, md (32px)
 * where the account is the subject, like a Sign-ins row or its profile dialog.
 */
export function AccountAvatar({ profile, size = 'md', className, label }: { profile: ResolvedProfile; size?: Size; className?: string; label?: string }) {
  const text = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const node = text.current;
    if (!node) return;
    const room = (node.parentElement?.clientWidth ?? 0) * LABEL_ROOM;
    // offsetWidth is the label's width before any scale; a hidden avatar (no width) is left as it is.
    node.style.transform = room && node.offsetWidth > room ? `scale(${room / node.offsetWidth})` : '';
  }, [profile.avatar, size]);
  const length = Math.min(Math.max(avatarCharacters(profile.avatar).length, 1), 3);
  return (
    <span
      className={cn('account-chip account-fill squircle inline-flex shrink-0 items-center justify-center font-semibold', box[size], labelSize[size][length - 1], className)}
      style={{ '--account-color': identityColorCss(profile.color) } as CSSProperties}
      data-fill={profile.fill}
      data-ink={profile.fill === 'solid' && identityColorIsLight(profile.color) ? 'dark' : undefined}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      title={profile.name}
    >
      {/* Trimmed to the capitals so they sit in the middle of the box, not the line's middle. */}
      <span ref={text} className="whitespace-nowrap [text-box:trim-both_cap_alphabetic]">{profile.avatar}</span>
    </span>
  );
}
