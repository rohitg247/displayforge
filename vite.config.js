import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { readFileSync } from "fs";
import { componentTagger } from "lovable-tagger";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));
// Build timestamp baked in at `vite build` time. Surfaced in the Ambient viewer's on-screen
// debugger so we can confirm on the panel itself whether a redeploy actually took effect
// (the timestamp changes every build; a stale value means the deploy didn't land).
const BUILD_STAMP = new Date().toISOString().slice(0, 19).replace("T", " ") + " UTC";

export default defineConfig(({ mode }) => ({
  define: {
    __AMBIENT_BUILD__: JSON.stringify(BUILD_STAMP),
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    // Tizen TV WebKit on pre-2020 firmware (Chromium <= 76) cannot parse
    // optional chaining (?.) or nullish coalescing (??). Vite 5's default
    // 'modules' target ships those unchanged. Transpile down to ES2018.
    target: 'es2018',
  },
  server: {
    host: "::",
    port: 8080,
    hmr: {
      overlay: false,
    },
    proxy: {
      '/api':     { target: process.env.VITE_API_URL || 'http://localhost:8000', changeOrigin: true },
      '/uploads': { target: process.env.VITE_API_URL || 'http://localhost:8000', changeOrigin: true },
    },
  },
  preview: {
    port: 3200,
    host: '::',
    proxy: {
      '/api':     { target: process.env.VITE_API_URL || 'http://localhost:8888', changeOrigin: true },
      '/uploads': { target: process.env.VITE_API_URL || 'http://localhost:8888', changeOrigin: true },
    },
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
