/**
 * index.html's pre-paint script as the build inlines it: src/boot/bootHead.ts bundled into one classic script
 * (vite.config.js's bootShell()), for tests that run it against stand-in page globals.
 */
const built = await Bun.build({ entrypoints: [new URL('../../src/boot/bootHead.ts', import.meta.url).pathname], format: 'iife', target: 'browser' });
const [output] = built.outputs;
if (!output) throw new Error(`The pre-paint script didn't build: ${built.logs.join('\n')}`);
export const PRE_PAINT_SCRIPT = await output.text();
