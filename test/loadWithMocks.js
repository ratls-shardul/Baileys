const Module = require("module")

function loadWithMocks(modulePath, mocks) {
  const resolvedPath = require.resolve(modulePath)
  const originalLoad = Module._load

  Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request]
    }

    return originalLoad.call(this, request, parent, isMain)
  }

  delete require.cache[resolvedPath]

  try {
    return require(resolvedPath)
  } finally {
    Module._load = originalLoad
  }
}

function clearModule(modulePath) {
  delete require.cache[require.resolve(modulePath)]
}

module.exports = {
  loadWithMocks,
  clearModule
}
