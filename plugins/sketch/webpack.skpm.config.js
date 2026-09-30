const path = require('path')

// The plugin bundles packages/core/api.js, which is shared by all three plugins.
//
// Two things break when skpm's Babel touches it: the injected @babel/runtime
// helpers resolve relative to packages/core (which has no node_modules), and the helper
// imports turn a CommonJS file into an ES module, so its `module.exports`
// throws at runtime in Sketch. packages/core only uses syntax Sketch's JavaScriptCore
// runs natively, so keep Babel to src/ and leave shared code untranspiled.
module.exports = function (config) {
  config.resolve = config.resolve || {}
  config.resolve.modules = [path.resolve(__dirname, 'node_modules'), 'node_modules']
  for (const rule of config.module.rules) {
    const uses = [].concat(rule.use || rule.loader || [])
    const isBabel = uses.some((u) => String((u && u.loader) || u).includes('babel-loader'))
    if (isBabel) rule.include = [path.resolve(__dirname, 'src')]
  }
}
