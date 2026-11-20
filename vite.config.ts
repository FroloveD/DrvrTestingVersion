import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  // Превью внутри песочницы открывается с прокси-хоста *.e2b.app: без этого Vite отклоняет запрос 403
  preview: {
    allowedHosts: [".e2b.app", "localhost"],
  },
  server: {
    allowedHosts: [".e2b.app", "localhost"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
