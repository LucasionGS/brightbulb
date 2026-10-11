// Resolves the "@shared/*" import alias in the tsc-compiled test build
// (dist-test), which tsc leaves untouched. Vite resolves it for the app itself.
const Module = require("node:module");
const Path = require("node:path");

const shared = Path.join(__dirname, "../dist-test/src/shared");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith("@shared/")) {
    request = Path.join(shared, request.slice("@shared/".length));
  }
  return resolve.call(this, request, ...rest);
};
