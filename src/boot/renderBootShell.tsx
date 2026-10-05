import { renderToStaticMarkup } from 'react-dom/server';
import { BootShell } from './BootShell';

/** The static first screen as HTML, for vite.config.js's `bootShell()` to put inside index.html's `#root`. */
export const renderBootShell = () => renderToStaticMarkup(<BootShell />);
