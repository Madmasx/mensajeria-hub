const esbuild = require('esbuild');
const path = require('path');

const isWatch = process.argv.includes('--watch');

const buildOptions = [
  {
    entryPoints: [path.join(__dirname, 'src/main/index.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    external: ['electron'],
    outfile: path.join(__dirname, 'dist/main/index.js'),
    sourcemap: true,
  },
  {
    entryPoints: [path.join(__dirname, 'src/preload/index.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    external: ['electron'],
    outfile: path.join(__dirname, 'dist/preload/index.js'),
    sourcemap: true,
  },
  {
    entryPoints: [path.join(__dirname, 'src/preload/account.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    external: ['electron'],
    outfile: path.join(__dirname, 'dist/preload/account.js'),
    sourcemap: true,
  }
];

async function run() {
  for (const opt of buildOptions) {
    if (isWatch) {
      const ctx = await esbuild.context(opt);
      await ctx.watch();
    } else {
      await esbuild.build(opt);
    }
  }
  console.log('Main and preload build complete.');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
