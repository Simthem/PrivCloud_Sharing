import { Box, Center, Loader } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { fetchFilePreviewSource } from "../../services/share.service";
import { MODEL_PREVIEW_MAX_SIZE } from "../../utils/modelPreview.util";
import { readPreviewBytes } from "../../utils/previewRange.util";

type Three = typeof import("three");

/** Only resources inside the file: nothing is fetched for a glTF. */
const insideFile = (url: string) =>
  url.startsWith("data:") || url.startsWith("blob:") ? url : "data:,";

async function parseModel(
  THREE: Three,
  mimeType: string,
  bytes: Uint8Array<ArrayBuffer>,
) {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  const material = (geometry: import("three").BufferGeometry) =>
    new THREE.MeshStandardMaterial({
      color: geometry.hasAttribute("color") ? 0xffffff : 0x9aa4b2,
      vertexColors: geometry.hasAttribute("color"),
      metalness: 0.1,
      roughness: 0.7,
      side: THREE.DoubleSide,
    });
  // STL files often store zero or wrong normals: they are always recomputed.
  const mesh = (
    geometry: import("three").BufferGeometry,
    normals = geometry.hasAttribute("normal"),
  ) => {
    if (!normals) geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, material(geometry));
  };
  switch (mimeType) {
    case "model/stl": {
      const { STLLoader } =
        await import("three/examples/jsm/loaders/STLLoader.js");
      return mesh(new STLLoader().parse(buffer), false);
    }
    case "model/x-ply": {
      const { PLYLoader } =
        await import("three/examples/jsm/loaders/PLYLoader.js");
      return mesh(new PLYLoader().parse(buffer));
    }
    case "model/obj": {
      const { OBJLoader } =
        await import("three/examples/jsm/loaders/OBJLoader.js");
      const group = new OBJLoader().parse(new TextDecoder().decode(bytes));
      group.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.computeVertexNormals();
          child.material = material(child.geometry);
        }
      });
      return group;
    }
    default: {
      const { GLTFLoader } =
        await import("three/examples/jsm/loaders/GLTFLoader.js");
      const manager = new THREE.LoadingManager();
      manager.setURLModifier(insideFile);
      const gltf = await new GLTFLoader(manager).parseAsync(buffer, "");
      return gltf.scene;
    }
  }
}

/** Every geometry, material and texture under `root`. */
function dispose(root: import("three").Object3D) {
  root.traverse((child) => {
    if (!("geometry" in child)) return;
    const mesh = child as import("three").Mesh;
    mesh.geometry.dispose();
    for (const material of [mesh.material].flat()) {
      for (const value of Object.values(material))
        if (value && typeof value === "object" && "isTexture" in value)
          (value as import("three").Texture).dispose();
      material.dispose();
    }
  });
}

/** STL, OBJ, PLY and self-contained glTF models, drawn on the device. */
export default function ModelPreview({
  shareId,
  fileId,
  e2eKey,
  mimeType,
  onError,
}: {
  shareId: string;
  fileId: string;
  e2eKey?: string | null;
  mimeType: string;
  onError: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const failed = useRef(onError);
  failed.current = onError;

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const controller = new AbortController();
    const { signal } = controller;
    let cleanup: (() => void) | undefined;
    setLoading(true);
    (async () => {
      const source = await fetchFilePreviewSource(
        shareId,
        fileId,
        e2eKey,
        signal,
      );
      if (source.size > MODEL_PREVIEW_MAX_SIZE) throw new Error("Too large");
      const bytes = await readPreviewBytes(source, 0, source.size, signal);
      const THREE = await import("three");
      const { OrbitControls } =
        await import("three/examples/jsm/controls/OrbitControls.js");
      const model = await parseModel(
        THREE,
        mimeType.toLowerCase().split(";")[0].trim(),
        bytes as Uint8Array<ArrayBuffer>,
      );
      if (signal.aborted) return dispose(model);

      const renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      element.appendChild(renderer.domElement);
      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2));
      const light = new THREE.DirectionalLight(0xffffff, 2);
      scene.add(model);

      // Centered and framed, whatever the units of the file.
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3()).length() || 1;
      model.position.sub(box.getCenter(new THREE.Vector3()));
      const camera = new THREE.PerspectiveCamera(45, 1, size / 1000, size * 20);
      camera.position.set(size * 0.6, size * 0.45, size * 0.9);
      camera.add(light);
      light.position.set(1, 1, 2);
      scene.add(camera);
      const controls = new OrbitControls(camera, renderer.domElement);
      const render = () => renderer.render(scene, camera);
      controls.addEventListener("change", render);
      const resize = () => {
        const width = element.clientWidth;
        const height = element.clientHeight;
        if (!width || !height) return;
        renderer.setSize(width, height);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        render();
      };
      const observer = new ResizeObserver(resize);
      observer.observe(element);
      resize();
      setLoading(false);
      cleanup = () => {
        observer.disconnect();
        controls.dispose();
        dispose(model);
        renderer.dispose();
        renderer.domElement.remove();
      };
    })().catch(() => {
      if (!signal.aborted) failed.current();
    });
    return () => {
      controller.abort();
      cleanup?.();
    };
  }, [shareId, fileId, e2eKey, mimeType]);

  return (
    <Box
      ref={container}
      pos="relative"
      h="min(70vh, 640px)"
      style={{ touchAction: "none", cursor: "grab" }}
    >
      {loading && (
        <Center pos="absolute" inset={0}>
          <Loader />
        </Center>
      )}
    </Box>
  );
}
