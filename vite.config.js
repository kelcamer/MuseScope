import { execSync } from "node:child_process";
import { defineConfig } from "vite";

// A visible build id. Three separate times we couldn't tell whether the browser
// was showing new code or a cached copy, and guessing wasted more than this
// costs: the commit hash is stamped into the page and shown in the header.
function buildId() {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "dev";
  }
}

// Served from https://kelcamer.github.io/MuseScope/
export default defineConfig({
  base: "/MuseScope/",
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
  },
});
