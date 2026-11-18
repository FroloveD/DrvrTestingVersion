/**
 * @module utils/cn
 * @layer ui
 * @role Объединение условных CSS-классов Tailwind (`clsx` + `tailwind-merge`).
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
