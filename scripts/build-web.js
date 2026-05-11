#!/usr/bin/env node
// Bundle web/src into web/dist using esbuild. The output is committed so
// `npx claude-remote-free` works without a build step.
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.resolve(__dirname, '..', 'web', 'src');
const OUT = path.resolve(__dirname, '..', 'web', 'dist');

fs.mkdirSync(OUT, { recursive: true });

async function build() {
  await esbuild.build({
    entryPoints: [path.join(SRC, 'app.ts')],
    bundle: true,
    format: 'iife',
    target: ['es2020'],
    outfile: path.join(OUT, 'app.js'),
    sourcemap: false,
    minify: true,
    plugins: [
      {
        name: 'inline-xterm-css',
        setup(b) {
          b.onLoad({ filter: /xterm\.css$/ }, async (args) => {
            const css = await fs.promises.readFile(args.path, 'utf8');
            return {
              contents:
                `const __xtermCss = ${JSON.stringify(css)};` +
                `const __s = document.createElement('style');` +
                `__s.textContent = __xtermCss;` +
                `document.head.appendChild(__s);` +
                `export default __xtermCss;`,
              loader: 'js',
            };
          });
        },
      },
    ],
  });

  for (const f of ['index.html', 'app.css']) {
    fs.copyFileSync(path.join(SRC, f), path.join(OUT, f));
  }

  console.log('web bundle written to', OUT);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
