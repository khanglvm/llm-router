import { WEB_CONSOLE_CSS } from "./web-console-styles.generated.js";

export { WEB_CONSOLE_CSS };

export function renderWebConsoleHtml({
  title = "LLM Router Web Console",
  headHtml = "",
  bodyHtml = ""
} = {}) {
  return String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>${title}</title>
    ${headHtml}
    <link rel="stylesheet" href="/styles.css">
    <script src="/app.js" defer></script>
  </head>
  <body>
    <div id="app"></div>
    ${bodyHtml}
  </body>
</html>`;
}
