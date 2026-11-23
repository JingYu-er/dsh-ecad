/**
 * 浏览器端 3D 实体视图（S214）：把 KiCad 导出的 GLB 放进 three.js。
 *
 * 为什么走 GLB 而不是自己画：`kicad-cli pcb export glb` 导出的就是 KiCad 3D 查看器
 * 用的那份实体——板体、铜层、丝印、阻焊、器件 3D 模型、材质与金属度全在里面。
 * 自己按包围盒堆方块只能示意位置，观感与 KiCad 渲染必然两回事。
 *
 * 这个文件是 ESM + three 的源码，构建时由 esbuild 打成 `client/viewer.bundle.js`
 * （IIFE，全局名 `EcadViewer`），由面板按需用 <script> 加载；面板本身仍是手写纯 JS，
 * 不把 three 塞进 client.js（那会让主面板每次加载都背 700 KB）。
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

/** GLB 能不能用：没有 WebGL2 上下文就退回 2D 草图。 */
export function canRender() {
  try {
    const probe = document.createElement("canvas");
    return Boolean(probe.getContext("webgl2") || probe.getContext("webgl"));
  } catch (error) {
    return false;
  }
}

/**
 * 挂一个板子到 canvas 上。
 *
 * 坐标约定：实测 KiCad 10 导出的 GLB 是**米制、Y 向上**，板面在 XZ 平面
 * （板面 x → 世界 x，板面 y → 世界 z，厚度沿世界 y）。所以根节点只放大 1000 倍换成毫米，
 * 不做旋转；焦点框直接用后端给的 mm 包围盒。
 */
export function mountBoard(canvas, options) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // 色调映射用线性：GLB 里的材质颜色已经是 KiCad 3D 查看器用的那一套（阻焊 alpha 0.83、
  // 铜金色、丝印白），再套 ACES 会把板子洗成粉绿。
  renderer.toneMapping = THREE.NoToneMapping;
  // 接地阴影：板子悬空会显得"贴纸"。开软阴影 + 一块只接收阴影的地面。
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  // 金属材质（焊盘、铜）必须有环境贴图才反光，否则一片死黑；但同强度照在阻焊上会把
  // 深绿洗成灰绿。所以环境照常给，进模型后按 metalness 逐个调 envMapIntensity。
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 1.0;

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 2000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 5;
  controls.maxDistance = 600;

  const key = new THREE.DirectionalLight(0xffffff, 3.1);
  key.position.set(60, 90, 40);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 400;
  key.shadow.camera.left = -140;
  key.shadow.camera.right = 140;
  key.shadow.camera.top = 140;
  key.shadow.camera.bottom = -140;
  key.shadow.bias = -0.0005;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xdfe8ff, 0.75);
  fill.position.set(-70, 40, -60);
  scene.add(fill);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x2a3038, 0.6));

  // KiCad 导出的 GLB 是「米」制、Y 向上，板面在 XZ 平面：板面 (x, y) → 世界 (x, ?, y)。
  // 放大 1000 倍换成毫米，这样包围盒、相机距离、焦点框都用同一套 mm 数值。
  const root = new THREE.Group();
  root.scale.setScalar(1000);
  scene.add(root);

  const focusGroup = new THREE.Group();
  scene.add(focusGroup);

  const state = { disposed: false, raf: 0, board: null };

  const resize = () => {
    const width = Math.max(canvas.clientWidth, 1);
    const height = Math.max(canvas.clientHeight, 1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);

  const frame = () => {
    if (state.disposed) return;
    controls.update();
    renderer.render(scene, camera);
    state.raf = window.requestAnimationFrame(frame);
  };

  const shadowGround = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.24 }),
  );
  shadowGround.rotation.x = -Math.PI / 2;
  shadowGround.receiveShadow = true;
  shadowGround.position.y = -0.35;
  scene.add(shadowGround);

  const fit = (box) => {
    const size = new THREE.Vector3();
    box.getSize(size);
    const center = new THREE.Vector3();
    box.getCenter(center);
    const radius = Math.max(size.x, size.z, 10) * 0.5;
    const distance = radius / Math.tan((camera.fov * Math.PI) / 360) * 1.15;
    camera.position.set(center.x + distance * 0.55, center.y + distance * 0.75, center.z + distance * 0.85);
    // 地面跟着板子大小铺开，只用来接阴影，不参与取景。
    const span = Math.max(size.x, size.z, 10) * 2.2;
    shadowGround.scale.set(span, span, 1);
    shadowGround.position.set(center.x, -0.35, center.z);
    controls.target.copy(center);
    camera.near = Math.max(distance / 200, 0.1);
    camera.far = distance * 20;
    camera.updateProjectionMatrix();
    controls.update();
  };

  /** 焦点框：后端给的是板面 mm 包围盒（x/y 与厚度），这里换到世界坐标。 */
  const setFocus = (boxes, focus) => {
    while (focusGroup.children.length > 0) {
      const child = focusGroup.children.pop();
      if (child && child.geometry) child.geometry.dispose();
      if (child && child.material) child.material.dispose();
    }
    if (typeof focus !== "string" || focus === "" || !Array.isArray(boxes)) return;
    const hit = boxes.find((item) => item && item.ref === focus);
    if (!hit) return;
    const thickness = state.board === null ? 1.6 : state.board.thicknessMm;
    const box = new THREE.Box3(
      new THREE.Vector3(hit.x0, 0, hit.y0),
      new THREE.Vector3(hit.x1, thickness + (hit.heightMm || 0) + 0.6, hit.y1),
    );
    const helper = new THREE.Box3Helper(box, new THREE.Color(0xffb020));
    focusGroup.add(helper);
  };

  const load = async () => {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(options.url);
    if (state.disposed) return;
    root.add(gltf.scene);
    // 按材质分流环境强度：金属要反射，阻焊/丝印只需要一点点环境色。
    gltf.scene.traverse((object) => {
      const holder = object;
      const material = holder.material;
      if (!material) return;
      const list = Array.isArray(material) ? material : [material];
      for (const item of list) {
        const metal = typeof item.metalness === "number" ? item.metalness : 0;
        item.envMapIntensity = metal > 0.5 ? 2.6 : 0;
        if (metal > 0.5) {
          item.metalness = Math.min(item.metalness, 0.85);
          item.roughness = Math.max(item.roughness ?? 0.3, 0.32);
        }
        holder.castShadow = true;
        holder.receiveShadow = true;
        // KiCad 写进 GLB 的 baseColorFactor 是 sRGB 数值（0.08/0.2/0.14 就是深绿阻焊），
        // 而 glTF 规范要求线性——照规范解释会整体提亮成灰绿。这里按 sRGB 还原。
        if (item.color && typeof item.color.setRGB === "function") {
          const factor = { r: item.color.r, g: item.color.g, b: item.color.b };
          item.color.setRGB(factor.r, factor.g, factor.b, THREE.SRGBColorSpace);
        }
        item.needsUpdate = true;
      }
    });
    const box = new THREE.Box3().setFromObject(root);
    state.board = options.board || null;
    fit(box);
    setFocus(options.boxes, options.focus);
    state.raf = window.requestAnimationFrame(frame);
  };

  const handle = {
    dispose() {
      state.disposed = true;
      window.cancelAnimationFrame(state.raf);
      observer.disconnect();
      controls.dispose();
      pmrem.dispose();
      renderer.dispose();
    },
    setFocus(next) {
      setFocus(options.boxes, next);
    },
    reload(url) {
      options.url = url;
      return load();
    },
  };

  load().catch((error) => {
    if (typeof options.onError === "function") options.onError(error);
  });
  return handle;
}
