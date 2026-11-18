/**
 * @module main
 * @layer ui
 * @role Точка входа браузерного приложения: монтирует корневой компонент `App` в `#root`.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
