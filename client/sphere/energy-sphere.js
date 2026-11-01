import * as THREE from '../vendor/three.module.min.js';
import { EffectComposer } from '../vendor/addons/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../vendor/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../vendor/addons/postprocessing/OutputPass.js';
import { ShaderPass } from '../vendor/addons/postprocessing/ShaderPass.js';
import { heartbeatAt } from './animation.js';
import { assertContainer, normalizeOptions, validatePulseStrength } from './options.js';

const TAU = Math.PI * 2;
export const CORE_VISUAL_SCALE = 1.22;

export const OUTER_RING_DEFINITIONS = [
  { radius: 3, seed: 81, density: 14, rotation: [0, 0, 0], speed: 0.11, viewPlane: true },
  { radius: 3, seed: 191, density: 18, rotation: [Math.PI / 2, 0, 0], speed: -0.075 },
  { radius: 3, seed: 291, density: 10, rotation: [0, Math.PI / 2, 0], speed: 0.045 },
];

export function ringNormal(rotation) {
  return new THREE.Vector3(0, 0, 1).applyEuler(new THREE.Euler(...rotation));
}

export function orientRing(group, definition, cameraPosition) {
  if (definition.viewPlane) {
    group.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      cameraPosition.clone().normalize(),
    );
    return;
  }
  group.rotation.set(...definition.rotation);
}

export function updateRingPose(ring, definition, elapsed, rotationSpeed) {
  ring.spin.rotation.z = definition.rotation[2] + elapsed * definition.speed * rotationSpeed;
}

function randomGenerator(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function glowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(255,255,255,0.8)');
  gradient.addColorStop(0.16, 'rgba(120,235,255,0.35)');
  gradient.addColorStop(0.48, 'rgba(30,170,230,0.09)');
  gradient.addColorStop(1, 'rgba(0,80,140,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
}

function particleMaterial(color, pixelRatio, size = 12) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uPixelRatio: { value: pixelRatio },
      uSize: { value: size },
      uOpacity: { value: 1 },
      uBrightness: { value: 1 },
    },
    vertexShader: `
      uniform float uPixelRatio;
      uniform float uSize;
      attribute float aScale;
      varying float vScale;
      void main() {
        vScale = aScale;
        vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * viewPosition;
        gl_PointSize = uSize * aScale * uPixelRatio / max(1.0, -viewPosition.z);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uBrightness;
      varying float vScale;
      void main() {
        float distanceToCenter = length(gl_PointCoord - 0.5);
        float alpha = smoothstep(0.5, 0.04, distanceToCenter);
        float core = smoothstep(0.2, 0.0, distanceToCenter);
        vec3 color = mix(uColor, vec3(0.85, 1.0, 1.0), core * 0.85);
        gl_FragColor = vec4(color, alpha * uOpacity * uBrightness * (0.55 + vScale * 0.45));
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

function fibonacciPoints(count, radius, random, jitter = 0) {
  const positions = new Float32Array(count * 3);
  const scales = new Float32Array(count);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const points = [];
  for (let index = 0; index < count; index += 1) {
    const y = 1 - (index / (count - 1)) * 2;
    const ringRadius = Math.sqrt(1 - y * y);
    const angle = golden * index;
    const localRadius = radius + (random() - 0.5) * jitter;
    const point = new THREE.Vector3(
      Math.cos(angle) * ringRadius * localRadius,
      y * localRadius,
      Math.sin(angle) * ringRadius * localRadius,
    );
    points.push(point);
    point.toArray(positions, index * 3);
    scales[index] = 0.35 + random() * 0.9;
  }
  return { positions, scales, points };
}

function createCore(color, pixelRatio) {
  const random = randomGenerator(701);
  const group = new THREE.Group();
  const shaderMaterials = [];
  const colorMaterials = [];

  const surfaceMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uTime: { value: 0 },
      uBeat: { value: 0 },
      uBrightness: { value: 1 },
    },
    vertexShader: `
      uniform float uTime;
      uniform float uBeat;
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec3 vPosition;
      void main() {
        vPosition = position;
        float ripple = sin(position.y * 10.0 + uTime * 1.8) * sin(position.x * 8.0 - uTime) * 0.012;
        vec3 displaced = position + normal * ripple * (0.4 + uBeat);
        vec4 viewPosition = modelViewMatrix * vec4(displaced, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-viewPosition.xyz);
        gl_Position = projectionMatrix * viewPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uTime;
      uniform float uBeat;
      uniform float uBrightness;
      varying vec3 vNormal;
      varying vec3 vView;
      varying vec3 vPosition;
      void main() {
        float fresnel = pow(1.0 - abs(dot(vNormal, vView)), 2.5);
        float bands = pow(abs(sin(vPosition.y * 17.0 + sin(vPosition.x * 8.0) + uTime * 0.25)), 22.0);
        float alpha = 0.025 + fresnel * 0.3 + bands * 0.035;
        vec3 color = uColor * (0.55 + fresnel * 1.6 + uBeat * 0.18) * uBrightness;
        gl_FragColor = vec4(color, alpha * uBrightness);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  shaderMaterials.push(surfaceMaterial);
  const surface = new THREE.Mesh(new THREE.IcosahedronGeometry(1.48, 5), surfaceMaterial);
  group.add(surface);

  const cloud = fibonacciPoints(1150, 1.53, random, 0.09);
  const cloudGeometry = new THREE.BufferGeometry();
  cloudGeometry.setAttribute('position', new THREE.BufferAttribute(cloud.positions, 3));
  cloudGeometry.setAttribute('aScale', new THREE.BufferAttribute(cloud.scales, 1));
  const cloudMaterial = particleMaterial(color, pixelRatio, 19);
  shaderMaterials.push(cloudMaterial);
  group.add(new THREE.Points(cloudGeometry, cloudMaterial));

  const connections = [];
  for (let index = 0; index < cloud.points.length; index += 1) {
    const point = cloud.points[index];
    let linked = 0;
    for (let other = index + 1; other < cloud.points.length && linked < 2; other += 1) {
      const candidate = cloud.points[other];
      const distance = point.distanceTo(candidate);
      if (distance < 0.19 && random() > 0.25) {
        connections.push(point.x, point.y, point.z, candidate.x, candidate.y, candidate.z);
        linked += 1;
      }
    }
  }
  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(connections, 3));
  const lineMaterial = new THREE.LineBasicMaterial({
    color, transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  colorMaterials.push(lineMaterial);
  group.add(new THREE.LineSegments(lineGeometry, lineMaterial));

  const wireMaterial = new THREE.LineBasicMaterial({
    color, transparent: true, opacity: 0.075, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  colorMaterials.push(wireMaterial);
  group.add(new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(1.5, 2)), wireMaterial));

  const sparks = fibonacciPoints(440, 1.83, random, 0.34);
  const sparkGeometry = new THREE.BufferGeometry();
  sparkGeometry.setAttribute('position', new THREE.BufferAttribute(sparks.positions, 3));
  sparkGeometry.setAttribute('aScale', new THREE.BufferAttribute(sparks.scales, 1));
  const sparkMaterial = particleMaterial(color, pixelRatio, 12);
  sparkMaterial.uniforms.uOpacity.value = 0.55;
  shaderMaterials.push(sparkMaterial);
  group.add(new THREE.Points(sparkGeometry, sparkMaterial));

  const innerMaterial = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.12, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  colorMaterials.push(innerMaterial);
  const innerRing = new THREE.Mesh(new THREE.TorusGeometry(1.16, 0.008, 5, 160), innerMaterial);
  innerRing.rotation.set(1.1, 0.25, 0.2);
  group.add(innerRing);

  for (const material of colorMaterials) material.userData.baseOpacity = material.opacity;
  return { group, shaderMaterials, colorMaterials, surfaceMaterial, innerRing };
}

function createRing(radius, color, seed, density = 12) {
  const random = randomGenerator(seed);
  const group = new THREE.Group();
  const spin = new THREE.Group();
  group.add(spin);
  const materials = [];
  const baseMaterial = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.13, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  materials.push(baseMaterial);
  spin.add(new THREE.Mesh(new THREE.TorusGeometry(radius, 0.007, 4, 256), baseMaterial));

  for (let index = 0; index < density; index += 1) {
    const start = (index / density) * TAU + random() * 0.08;
    const arc = 0.08 + random() * 0.36;
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.28 + random() * 0.5,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    materials.push(material);
    const mesh = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.009 + random() * 0.009, 5, 36, arc), material);
    mesh.rotation.z = start;
    mesh.position.z = (random() - 0.5) * 0.07;
    spin.add(mesh);
  }

  const tickMaterial = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.32, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  materials.push(tickMaterial);
  const tickCount = 96;
  const ticks = new THREE.InstancedMesh(new THREE.BoxGeometry(0.012, 0.075, 0.012), tickMaterial, tickCount);
  const transform = new THREE.Object3D();
  for (let index = 0; index < tickCount; index += 1) {
    const angle = (index / tickCount) * TAU;
    const tickRadius = radius + (index % 8 === 0 ? 0.09 : 0.055);
    transform.position.set(Math.cos(angle) * tickRadius, Math.sin(angle) * tickRadius, 0);
    transform.rotation.z = angle - Math.PI / 2;
    transform.scale.y = index % 8 === 0 ? 1.8 : 0.55;
    transform.updateMatrix();
    ticks.setMatrixAt(index, transform.matrix);
  }
  spin.add(ticks);

  const nodeMaterial = new THREE.MeshBasicMaterial({
    color: '#b6f7ff', transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  for (let index = 0; index < 5; index += 1) {
    const angle = random() * TAU;
    const node = new THREE.Mesh(new THREE.SphereGeometry(0.025 + random() * 0.018, 6, 6), nodeMaterial);
    node.position.set(Math.cos(angle) * radius, Math.sin(angle) * radius, 0.02);
    spin.add(node);
  }
  return { group, spin, materials };
}

function createOrbitalDust(color, pixelRatio) {
  const random = randomGenerator(1701);
  const count = 520;
  const positions = new Float32Array(count * 3);
  const scales = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const angle = random() * TAU;
    const radius = 2.1 + random() * 1.55;
    positions[index * 3] = Math.cos(angle) * radius;
    positions[index * 3 + 1] = Math.sin(angle) * radius;
    positions[index * 3 + 2] = (random() - 0.5) * 0.6;
    scales[index] = 0.2 + random() * 0.65;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));
  const material = particleMaterial(color, pixelRatio, 10);
  material.uniforms.uOpacity.value = 0.45;
  return new THREE.Points(geometry, material);
}

function disposeScene(scene) {
  const textures = new Set();
  scene.traverse((object) => {
    object.geometry?.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material) continue;
      for (const value of Object.values(material)) {
        if (value?.isTexture) textures.add(value);
      }
      if (material.uniforms) {
        for (const uniform of Object.values(material.uniforms)) {
          if (uniform.value?.isTexture) textures.add(uniform.value);
        }
      }
      material.dispose();
    }
  });
  textures.forEach((texture) => texture.dispose());
}

export function createEnergySphere(container, initialOptions = {}) {
  assertContainer(container);
  let options = normalizeOptions({}, initialOptions);
  let disposed = false;
  let contextLost = false;
  let frameId = null;
  let elapsed = 0;
  let coreElapsed = 0;
  let lastTime = performance.now();
  let manualPulseStarted = -Infinity;
  let manualPulseStrength = 0;
  const onError = typeof initialOptions.onError === 'function' ? initialOptions.onError : () => {};

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  } catch (cause) {
    onError(new Error('EnergySphere could not initialize WebGL', { cause }));
    return { update() {}, pulse() {}, dispose() {} };
  }

  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(pixelRatio);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.domElement.setAttribute('aria-hidden', 'true');
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(4.4, 2.8, 8);
  camera.lookAt(0, 0, 0);

  const world = new THREE.Group();
  world.rotation.x = 0;
  scene.add(world);

  const core = createCore(options.color, pixelRatio);
  world.add(core.group);

  const haloMaterial = new THREE.SpriteMaterial({
    map: glowTexture(), color: options.color, transparent: true, opacity: 0.3,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const halo = new THREE.Sprite(haloMaterial);
  halo.scale.set(5.8, 5.8, 1);
  halo.position.z = -0.8;
  world.add(halo);

  const rings = OUTER_RING_DEFINITIONS.map((definition) => {
    const ring = createRing(definition.radius, options.color, definition.seed, definition.density);
    orientRing(ring.group, definition, camera.position);
    world.add(ring.group);
    return ring;
  });

  const dustMaterial = createOrbitalDust(options.color, pixelRatio);
  dustMaterial.rotation.set(0.25, -0.1, 0);
  world.add(dustMaterial);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.45, 0.58, 0.32);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  // 透明背景：UnrealBloomPass 的辉光链会把整帧 alpha 写成 1。整页深色背景看不出来，
  // 但组件要嵌进别人的页面（DSH 插件），那时候它就是一块不透明方块。
  // 末级 pass 用亮度还原 alpha，并把最外圈径向淡出（机械环约占半宽 0.82，从 0.84 起淡出不会切到环）。
  const transparentPass = new ShaderPass({
    uniforms: { tDiffuse: { value: null } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }',
    fragmentShader: [
      'uniform sampler2D tDiffuse;',
      'varying vec2 vUv;',
      'void main() {',
      '  vec4 c = texture2D( tDiffuse, vUv );',
      '  float d = distance( vUv, vec2( 0.5 ) ) * 2.0;',
      '  float mask = 1.0 - smoothstep( 0.84, 1.0, d );',
      '  float a = clamp( max( max( c.r, c.g ), c.b ), 0.0, 1.0 ) * mask;',
      '  gl_FragColor = vec4( c.rgb * mask, a );',
      '}',
    ].join( '\n' ),
  });
  composer.addPass(transparentPass);

  function resize() {
    if (disposed || contextLost) return;
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    composer.setSize(width, height);
  }

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  resize();

  function applyColor(color) {
    core.surfaceMaterial?.uniforms?.uColor?.value.set(color);
    for (const material of core.shaderMaterials) material.uniforms.uColor?.value.set(color);
    for (const material of core.colorMaterials) material.color.set(color);
    for (const ring of rings) for (const material of ring.materials) material.color.set(color);
    haloMaterial.color.set(color);
    dustMaterial.material.uniforms.uColor.value.set(color);
  }

  function currentHeart() {
    return options.heartbeatEnabled
      ? heartbeatAt(coreElapsed, options.bpm)
      : { beat: 0, scale: 1, glow: 1 };
  }

  function renderVisualState(heart, manual) {
    const pulse = heart.beat + manual;
    const scale = heart.scale * CORE_VISUAL_SCALE * options.coreScale * (1 + manual * 0.11);
    core.group.scale.setScalar(scale);
    core.group.rotation.y = coreElapsed * 0.055 * options.rotationSpeed;
    core.group.rotation.x = Math.sin(coreElapsed * 0.17) * 0.035;
    core.surfaceMaterial.uniforms.uTime.value = coreElapsed;
    core.surfaceMaterial.uniforms.uBeat.value = pulse;
    for (const material of core.shaderMaterials) {
      if (material.uniforms.uBrightness) material.uniforms.uBrightness.value = options.coreBrightness;
    }
    for (const material of core.colorMaterials) {
      material.opacity = material.userData.baseOpacity * options.coreBrightness;
    }
    core.innerRing.rotation.z = coreElapsed * 0.2;
    rings.forEach((ring, index) => {
      updateRingPose(ring, OUTER_RING_DEFINITIONS[index], elapsed, options.rotationSpeed);
    });
    dustMaterial.rotation.z = -elapsed * 0.018 * options.rotationSpeed;
    haloMaterial.opacity = (0.025 + heart.glow * 0.035 + manual * 0.025)
      * options.energy * options.coreBrightness;
    halo.scale.setScalar(5.5 + pulse * 0.22);
    bloom.strength = (0.22 + heart.glow * 0.16 + manual * 0.12)
      * options.energy * options.coreBrightness;
    composer.render();
  }

  function animate(now) {
    frameId = null;
    if (disposed || contextLost || document.hidden) return;
    const delta = Math.min(0.05, Math.max(0, (now - lastTime) / 1000));
    lastTime = now;
    const manualAge = (now - manualPulseStarted) / 1000;
    const manualActive = manualAge >= 0 && manualAge < 0.9;
    const manual = manualActive
      ? Math.sin(Math.min(1, manualAge / 0.9) * Math.PI) * Math.exp(-manualAge * 1.6) * manualPulseStrength
      : 0;

    if (!options.paused || manualActive) {
      elapsed += delta;
      if (options.heartbeatEnabled) coreElapsed += delta;
      renderVisualState(currentHeart(), manual);
    }
    frameId = requestAnimationFrame(animate);
  }

  function startLoop() {
    if (frameId === null && !disposed && !contextLost && !document.hidden) {
      lastTime = performance.now();
      frameId = requestAnimationFrame(animate);
    }
  }

  function handleVisibility() {
    if (document.hidden && frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    } else {
      startLoop();
    }
  }

  function handleContextLost(event) {
    event.preventDefault();
    contextLost = true;
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = null;
    onError(new Error('EnergySphere WebGL context was lost'));
  }

  document.addEventListener('visibilitychange', handleVisibility);
  renderer.domElement.addEventListener('webglcontextlost', handleContextLost);
  startLoop();

  return {
    update(patch) {
      if (disposed || contextLost) return;
      options = normalizeOptions(options, patch);
      if (patch.color) applyColor(patch.color);
      renderVisualState(currentHeart(), 0);
      startLoop();
    },
    pulse(strength = 1) {
      if (disposed || contextLost) return;
      manualPulseStrength = validatePulseStrength(strength);
      manualPulseStarted = performance.now();
      startLoop();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = null;
      resizeObserver.disconnect();
      document.removeEventListener('visibilitychange', handleVisibility);
      renderer.domElement.removeEventListener('webglcontextlost', handleContextLost);
      disposeScene(scene);
      bloom.dispose();
      composer.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
