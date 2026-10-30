// electron-builder leaves node_modules out of extraResources, and the Husk the
// app carries is a node_modules tree. So it is copied in here, after packing,
// next to app.asar: <resources>/runtime.
const { cpSync, existsSync } = require('node:fs');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  const from = join(__dirname, '..', 'build', 'runtime');
  if (!existsSync(join(from, 'node_modules'))) throw new Error('build/runtime is not staged; run `npm run stage` first');
  const resources =
    context.electronPlatformName === 'darwin'
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : join(context.appOutDir, 'resources');
  cpSync(from, join(resources, 'runtime'), { recursive: true });
};
