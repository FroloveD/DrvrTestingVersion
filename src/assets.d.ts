/// <reference types="vite/client" />

/**
 * @module assets
 * @layer build-types
 * @role Типы URL локальных SVG-ассетов, включаемых Vite в автономную сборку.
 */

declare module "*.svg?url" {
  const assetUrl: string;
  export default assetUrl;
}
