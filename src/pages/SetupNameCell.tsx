import { TableCell } from '../components/ui/table';

/**
 * A plugin's or server's name, with the marketplace or host under it, pinned while the table scrolls sideways. With
 * `onOpen`, the name opens the item's side sheet.
 */
export function NameCell({ name, note, onOpen, openLabel }: { name: string; note: string | null; onOpen?: () => void; openLabel?: string }) {
  const text = <span className="truncate font-mono text-xs text-foreground" title={name}>{name}</span>;
  return (
    <TableCell className="sticky left-0 z-10 max-w-72 bg-card">
      <div className="flex min-w-0 flex-col gap-0.5">
        {onOpen ? (
          <button
            type="button"
            className="flex min-w-0 cursor-pointer rounded-sm text-start underline-offset-2 outline-none ring-ring hover:underline focus-visible:ring-2"
            aria-label={openLabel}
            onClick={onOpen}
          >
            {text}
          </button>
        ) : text}
        {note ? <span className="truncate text-2xs text-muted-foreground" title={note}>{note}</span> : null}
      </div>
    </TableCell>
  );
}
