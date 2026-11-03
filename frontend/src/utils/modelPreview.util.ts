/** 3D models drawn on the device: STL, OBJ, PLY and self-contained glTF. */
export const MODEL_PREVIEW_MAX_SIZE = 100 * 1024 * 1024;
export const isModelPreviewMimeType = (mimeType: string): boolean =>
  [
    "model/stl",
    "model/obj",
    "model/x-ply",
    "model/gltf-binary",
    "model/gltf+json",
  ].includes(mimeType.toLowerCase().split(";")[0].trim());
