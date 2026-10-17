import { readFileSync } from "node:fs";
export function deployedUrl() {
  const log = readFileSync("deployment.log", "utf8");
  const url = log.match(
    /https:\/\/224event\.[a-zA-Z0-9-]+\.workers\.dev\b/,
  )?.[0];
  if (!url)
    throw new Error("No 224event workers.dev URL found in deployment output");
  return url;
}
