import assert from "node:assert/strict";
import test from "node:test";
import { startWebConsoleDevAssets } from "./web-console-dev-assets.js";

test("web console dev assets build initial JS and CSS before serving", async () => {
  const changes = [];
  const errors = [];
  const assets = await startWebConsoleDevAssets({
    onChange(event) {
      changes.push(event);
    },
    onError(message) {
      errors.push(message);
    }
  });

  try {
    const appJs = assets.getAppJs();
    const stylesCss = assets.getStylesCss();

    assert.equal(assets.isDevMode, true);
    assert.match(appJs, /createRoot|react-dom|LLM Router Web|Provider models|Local Models/);
    assert.doesNotMatch(appJs, /Waiting for dev bundle/);
    assert.match(stylesCss, /tailwindcss|@layer|--color-background/);
    assert.equal(stylesCss.trim().length > 0, true);
    assert.deepEqual(errors, []);
    assert.equal(changes.length > 0, true);
  } finally {
    await assets.close();
  }
});
