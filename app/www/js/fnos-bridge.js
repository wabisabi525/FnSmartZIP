;(function (global) {
  "use strict";

  function isUsableSdk(sdk) {
    return Boolean(
      sdk && (
        typeof sdk.authorizeUserFile === "function"
        || typeof sdk.pickUserFile === "function"
      )
    );
  }

  function collectScopes(root) {
    const scopes = [];
    const seen = new Set();
    const add = (candidate) => {
      if (!candidate || seen.has(candidate)) {
        return;
      }
      seen.add(candidate);
      scopes.push(candidate);
    };
    add(root);
    try {
      add(root.parent);
    } catch (error) {
      // Cross-origin parent frames are not readable.
    }
    try {
      add(root.top);
    } catch (error) {
      // Cross-origin top frames are not readable.
    }
    return scopes;
  }

  function resolveSdk() {
    for (const scope of collectScopes(global)) {
      if (isUsableSdk(scope.fnApp)) {
        return scope.fnApp;
      }
      const constructors = [scope.TrimApp, scope.trimApp, scope.FnApp];
      for (const Candidate of constructors) {
        if (typeof Candidate !== "function") {
          continue;
        }
        try {
          const sdk = new Candidate();
          if (isUsableSdk(sdk)) {
            return sdk;
          }
        } catch (error) {
          // Try the next injected constructor.
        }
      }
      if (typeof scope.createFnApp === "function") {
        try {
          const sdk = scope.createFnApp();
          if (isUsableSdk(sdk)) {
            return sdk;
          }
        } catch (error) {
          // Try the next scope.
        }
      }
    }
    return null;
  }

  function isAvailable() {
    return Boolean(resolveSdk());
  }

  async function authorizeKnownPath(targetPath, options = {}) {
    const pathValue = String(targetPath || "").trim();
    if (!pathValue) {
      const error = new Error("没有可授权的文件路径");
      error.code = "SOURCE_PATH_INVALID";
      throw error;
    }
    const sdk = resolveSdk();
    if (!sdk) {
      const error = new Error("当前页面未接入飞牛授权接口，请在 fnOS 应用窗口中打开。");
      error.code = "SDK_UNAVAILABLE";
      throw error;
    }
    const directory = Boolean(options.directory);
    if (directory && typeof sdk.pickUserFile === "function") {
      await sdk.pickUserFile({ directory: true, path: pathValue });
      return { method: "pickUserFile", path: pathValue };
    }
    if (typeof sdk.authorizeUserFile === "function") {
      await sdk.authorizeUserFile(pathValue);
      return { method: "authorizeUserFile", path: pathValue };
    }
    if (typeof sdk.pickUserFile === "function") {
      await sdk.pickUserFile({ directory: true, path: pathValue });
      return { method: "pickUserFile", path: pathValue };
    }
    const error = new Error("当前飞牛 SDK 不支持文件授权。");
    error.code = "SDK_UNAVAILABLE";
    throw error;
  }

  global.fnosBridge = {
    authorizeKnownPath,
    isAvailable,
    resolveSdk,
  };
}(typeof window === "undefined" ? globalThis : window));
