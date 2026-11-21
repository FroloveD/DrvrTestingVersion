/// <reference types="vite/client" />

declare module "*.svg?url" {
  const assetUrl: string;
  export default assetUrl;
}
