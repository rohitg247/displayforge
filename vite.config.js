import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

export default defineConfig(({ mode }) => ({
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
