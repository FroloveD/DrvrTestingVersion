import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/** Полный путь к текущему файлу конфигурации (эмуляция __filename для ES-модулей). */
const __filename = fileURLToPath(import.meta.url);

/** Директория, в которой расположен файл vite.config.ts (эмуляция __dirname для ES-модулей). */
const __dirname = path.dirname(__filename);

/**
 * Конфигурация сборщика Vite:
 * - `react()` — поддержка JSX и Fast Refresh для React.
 * - `tailwindcss()` — интеграция Tailwind CSS v4.
 * - `viteSingleFile()` — упаковка всего JS и CSS в один автономный `dist/index.html` (для офлайн-работы и GitHub Pages).
 * - `resolve.alias` — псевдоним `@` для удобного импорта из папки `src`.
 */
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});