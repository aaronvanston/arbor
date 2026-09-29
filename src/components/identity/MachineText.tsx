import { Fragment } from 'react';
import type { MachineMention } from '../../services/machineMentions';
import { MachinePill, type MachinePillSize } from './Identity';

/**
 * Words kept as a service wrote them (an alert, a note), with each machine they name shown as its pill. The parts come
 * from machineMentions, which only knows a machine by the name it was given, never by guessing from the words.
 */
export function MachineText({ parts, size = 'sm' }: { parts: readonly MachineMention[]; size?: MachinePillSize }) {
  return (
    <>
      {parts.map((part, index) => ('machine' in part
        ? <MachinePill key={index} name={part.machine} size={size} />
        : <Fragment key={index}>{part.text}</Fragment>))}
    </>
  );
}
