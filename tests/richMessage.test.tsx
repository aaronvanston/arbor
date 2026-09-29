import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { translateRich } from '../src/i18n';
import { setMachineName } from '../src/services/machineNames';

describe('rich messages', () => {
  it('puts an element where its placeholder is, with the words either side', () => {
    const html = renderToStaticMarkup(<>{translateRich('machineScope.onMachine.open', { machine: <b>ci-01</b> })}</>);
    expect(html).toBe('Open <b>ci-01</b>');
  });

  it('says the name a machine is shown by when it’s given as words, as `translate` does', () => {
    setMachineName('ci-01', 'Build box');
    try {
      expect(renderToStaticMarkup(<>{translateRich('machineScope.onMachine.open', { machine: 'ci-01' })}</>)).toBe('Open Build box');
    } finally {
      setMachineName('ci-01', '');
    }
  });

  it('writes words and numbers in as they are, and leaves an unfilled placeholder showing', () => {
    const html = renderToStaticMarkup(<>{translateRich('machineScope.onMachine.open', { other: 'x' })}</>);
    expect(html).toBe('Open {machine}');
  });
});
