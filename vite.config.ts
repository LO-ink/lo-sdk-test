import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
const revision = process.env.BUILD_REVISION ?? "local";
if (revision !== "local" && !/^[a-f0-9]{40}$/.test(revision))
  throw new Error("BUILD_REVISION must be a full Git commit or local");
export default defineConfig({
  define: { __BUILD_REVISION__: JSON.stringify(revision) },
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5177,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:5407" },
  },
  build: { target: "es2022", sourcemap: false },
});
