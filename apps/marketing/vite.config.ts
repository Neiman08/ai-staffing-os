import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// F4.8: sitio público, desacoplado del CRM (apps/web) — puerto propio,
// mismo patrón de proxy /api hacia el backend real (solo para las rutas
// /api/v1/public/* que el backend expone sin auth, ver
// apps/api/src/modules/public/router.ts).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
});
