import * as THREE from 'three';
import './hybrid-layout.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildConsoleReceiver } from './console-receiver.js';
import { CabinReflections } from './cabin-reflections.js';
import { restoreModelDelta } from './model-delta.mjs';
import { unpackFinishPixels, finishPixelsToHalfFloat } from './finish-transport.mjs';
import { decodeFinishes } from './finish-loader.mjs';
import { settleGpu } from './gpu-settle.mjs';
import { preparationBudget } from './preparation-budget.mjs';

// Keep model metadata and captured finishes on one revision when updating an
// existing visit. Old unversioned browser entries can otherwise mix material keys.
const displayAsset = (path) => 'assets/displays/' + path + '?v=precision-20261002.1';
const preparationPause = () =>
  globalThis.scheduler?.yield
    ? globalThis.scheduler.yield()
    : new Promise((resolve) => setTimeout(resolve, 0));

// Reshape the captured radiance inside the existing matcap pass. Keep the
// original normals and their fine metal grain; no new lights or texture reads.
function polishFinishShader(shader, response) {
  shader.fragmentShader = shader.fragmentShader.replace(
    'vec3 outgoingLight = diffuseColor.rgb * matcapColor.rgb;',
    `float finishLuminance=dot(matcapColor.rgb,vec3(.2126,.7152,.0722));
    vec3 finishRadiance=mix(matcapColor.rgb,vec3(finishLuminance),${response}.z);
    finishRadiance=max(vec3(0.),finishRadiance*${response}.x-${response}.y);
    // A narrow light roll follows the real rounded bevel normal. Broad faces
    // and grazing shoulders stay dark instead of receiving a flat silver lift.
    float finishSlope=1.-clamp(dot(normal,viewDir),0.,1.);
    float finishRoll=smoothstep(.028,.095,finishSlope)*(1.-smoothstep(.18,.34,finishSlope));
    float finishKey=.48+.52*smoothstep(.055,.28,finishLuminance);
    finishRadiance+=vec3(.62*finishRoll*finishKey*${response}.w);
    vec3 outgoingLight=diffuseColor.rgb*finishRadiance;`,
  );
}

// The three standard GLBs reference one byte-identical normal image. Coalesce
// its fetch/decode only for this load; GLTFLoader otherwise caches per parser.
// Keep the native loader's browser decoding, sampling and texture semantics.
function createDisplayLoader() {
  const loader = new GLTFLoader(),
    pending = new Map();
  loader.register((parser) => ({
    name: 'SharedCockpitNormal',
    loadTexture(index) {
      const definition = parser.json.textures[index];
      const source = parser.json.images[definition.source];
      if (definition.extensions || !/^normal-blue-metal-[a-f0-9]{12}\.jpg$/.test(source?.uri || ''))
        return null;
      const key = JSON.stringify([
        parser.options.path,
        source,
        definition,
        parser.json.samplers?.[definition.sampler],
      ]);
      if (!pending.has(key)) {
        // Same 2048px normal field, encoded as high-quality WebP for transport.
        // Keep the model's original JPEG and sampler semantics as the fallback.
        const compactSource =
          parser.json.images.push({
            ...source,
            uri: source.uri.replace(/\.jpg$/, '.webp'),
            mimeType: 'image/webp',
          }) - 1;
        pending.set(
          key,
          parser
            .loadTextureImage(index, compactSource, parser.textureLoader)
            .then((texture) => texture || parser.loadTexture(index)),
        );
      }
      return pending.get(key).then((texture) => {
        if (!texture) throw Error('Display normal image unavailable');
        const copy = texture.clone();
        parser.associations.set(copy, { textures: index });
        return copy;
      });
    },
  }));
  return loader;
}

async function loadPackedBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Packed display asset unavailable');
  let bytes = await response.arrayBuffer();
  // Some hosts decode Content-Encoding themselves. Both modes preserve the
  // original bytes before the GLB or HDR parser sees them.
  const magic = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
  if (magic[0] === 31 && magic[1] === 139) {
    bytes = await new Response(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')),
    ).arrayBuffer();
  }
  return bytes;
}
async function loadDisplayModel(loader, url, packedBytes) {
  if (typeof DecompressionStream !== 'function') return loader.loadAsync(url);
  try {
    return await loader.parseAsync(
      await (packedBytes || loadPackedBytes(url.replace('.glb', '.glb.gz'))),
      url.slice(0, url.lastIndexOf('/') + 1),
    );
  } catch {
    // Older browsers and hosts with a missing compressed copy retain full detail.
    return loader.loadAsync(url);
  }
}
async function loadRightDisplay(loader, leftBytes) {
  const url = displayAsset('right.glb');
  if (leftBytes && globalThis.crypto?.subtle) {
    try {
      const [packed, base] = await Promise.all([
        loadPackedBytes(displayAsset('right.delta.gz')),
        leftBytes,
      ]);
      return await loader.parseAsync(
        await restoreModelDelta(packed, base),
        url.slice(0, url.lastIndexOf('/') + 1),
      );
    } catch {
      /* Missing/stale/corrupt delta keeps the full original model. */
    }
  }
  return loadDisplayModel(loader, url);
}

// The hardware, optical cover and HTML all use these same world-space planes.
// One transparent WebGL layer surrounds native HTML with the hardware and glass.
class PhysicalConsole {
  static async load(hinges, tilt) {
    performance.mark('cockpit-display-load-start');
    const captureFinishes = new URLSearchParams(location.search).get('bake-finishes') === '1';
    const loader = createDisplayLoader();
    const textureLoader = new THREE.TextureLoader();
    // Begin this compact material request before model requests occupy the
    // connection pool. It no longer waits for a manifest, then twelve fetches.
    const finishesReady = captureFinishes ? null : PhysicalConsole.fetchHardwareFinishes();
    const leftBytes =
      typeof DecompressionStream === 'function'
        ? loadPackedBytes(displayAsset('left.glb.gz'))
        : null;
    const [metadata, center, left, right, environment, deckTextures, receiverSource, finishAssets] =
      await Promise.all([
        fetch(displayAsset('geometry.json')).then((r) => {
          if (!r.ok) throw Error('Display geometry unavailable');
          return r.json();
        }),
        loadDisplayModel(loader, displayAsset('center.glb')),
        loadDisplayModel(loader, displayAsset('left.glb'), leftBytes),
        loadRightDisplay(loader, leftBytes),
        // Ordinary visits use saved metal finishes and local planar glass. The
        // studio environment is needed only for explicit developer re-capture.
        captureFinishes ? new HDRLoader().loadAsync('assets/displays/studio.hdr') : null,
        Promise.all(
          ['turquoise'].map(async (name) => {
            const path = `assets/cabin/${name}.webp`,
              texture = await textureLoader.loadAsync(path);
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.generateMipmaps = false;
            texture.minFilter = THREE.LinearFilter;
            // Decode/orient before the upload, while model downloads are in
            // flight. ImageBitmap ignores WebGL's flip flag, so bake that same
            // orientation explicitly. Keep the bitmap for context restoration.
            if (typeof createImageBitmap === 'function') {
              try {
                texture.image = await createImageBitmap(texture.image, {
                  imageOrientation: 'flipY',
                  premultiplyAlpha: 'none',
                });
                texture.flipY = false;
              } catch {
                // Original image remains a complete compatible fallback.
              }
            }
            return [new URL(path, document.baseURI).href, texture];
          }),
        ),
        fetch('assets/displays/console-receiver.json').then((r) => {
          if (!r.ok) throw Error('Console surfaces unavailable');
          return r.json();
        }),
        finishesReady,
      ]);
    let result;
    try {
      performance.mark('cockpit-display-assets-ready');
      await window.ConsoleLayout.whenMeasured();
      result = new PhysicalConsole(
        hinges,
        tilt,
        metadata,
        { center, left, right },
        environment,
        deckTextures,
        receiverSource,
      );
      await result.initializeModels({ center, left, right }, environment);
      performance.mark('cockpit-display-constructed');
      if (captureFinishes) await result.bakeHardwareFinishes();
      else await result.loadHardwareFinishes(finishAssets);
      performance.mark('cockpit-finish-assets-ready');
      await window.ConsoleLayout.whenMeasured(() => result.layout());
      result.updatePose();
      // Area-light shading is already captured into the hardware finishes.
      // Retain the light objects as spill geometry, without traversing or
      // preparing unused lights during either runtime render pass.
      for (const light of [
        result.fill,
        result.warm,
        ...Object.values(result.models).map((entry) => entry.light),
      ])
        light.removeFromParent();
      await result.batchHardware();
      performance.mark('cockpit-display-batched');
      // Upload once during loading, never while the visitor is travelling.
      for (const texture of result.deckTextures.values()) result.optics.initTexture(texture);
      await settleGpu(result.renderer.getContext());
      result.renderer.setRenderTarget(result.hardwareTarget);
      await result.renderer.compileAsync(result.scene, result.renderCamera);
      performance.mark('cockpit-hardware-programs-ready');
      result.renderer.setRenderTarget(null);
      result.renderCamera.layers.set(1);
      await result.optics.compileAsync(result.opticsScene, result.renderCamera);
      performance.mark('cockpit-optics-programs-ready');
      result.renderCamera.layers.set(0);
      await result.renderer.compileAsync(result.reflections.scene, result.camera);
      performance.mark('cockpit-reflection-programs-ready');
      document.getElementById('cockpit').classList.add('physical-console');
      hinges.physical = result;
      tilt.onChange = () => hinges.render();
      result.layoutDirty = true;
      await window.ConsoleLayout.whenMeasured(() => result.render());
    } catch (error) {
      result?.dispose();
      document
        .querySelectorAll('#display-hardware,#display-optics')
        .forEach((canvas) => canvas.remove());
      if (!window.HybridBoot) {
        document.querySelector('.reading-device').removeAttribute('style');
        document.getElementById('center-screen').removeAttribute('style');
        for (const side of ['left', 'right'])
          for (const property of ['transform', 'transform-origin', 'padding', 'will-change'])
            document.getElementById('monitor-hit-' + side).style.removeProperty(property);
      }
      throw error;
    }
    return result;
  }
  constructor(hinges, tilt, metadata, models, environment, deckTextures, receiverSource) {
    this.hinges = hinges;
    this.tilt = tilt;
    this.metadata = metadata;
    this.receiverSource = receiverSource;
    this.host = document.getElementById('cockpit');
    this.stage = document.getElementById('stage');
    this.neutral = document.getElementById('reading-layout');
    this.reader = document.querySelector('.reading-device');
    this.main = document.getElementById('center-screen');
    this.displayStage = document.getElementById('display-stage');
    this.sideElements = Object.fromEntries(
      ['left', 'right'].map((side) => [
        side,
        {
          screen: document.getElementById('side-' + side),
          hit: document.getElementById('monitor-hit-' + side),
          grip: document.getElementById('hinge-' + side),
        },
      ]),
    );
    this.layoutDirty = true;
    this.layoutVersion = 0;
    this.domState = new WeakMap();
    this.projectionKeys = {};
    this.stagedDOM = window.HybridBoot ? new Map() : null;
    this.normalTextures = new Map();
    this.deckTextures = new Map(deckTextures);
    this.matcapTargets = [];
    this.finishManifest = [];
    this.finishTextures = new Set();
    this.hardwareBatches = [];
    this.batchBindings = [];
    this.finishAtlasMaterials = new Set();
    this.stats = { hardwareFrames: 0, opticsFrames: 0, poseUpdates: 0 };
    this.diagnostics = new URLSearchParams(location.search).has('diagnostics');
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(20, 1, 0.1, 20000);
    // updatePose explicitly updates all world transforms. Reflection-only
    // frames and the second render pass reuse that same immutable pose.
    this.scene.matrixWorldAutoUpdate = false;
    this.renderCamera = new THREE.PerspectiveCamera();
    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: false,
      depth: false,
      powerPreference: 'high-performance',
    });
    // Production shaders are exercised by release QA. Per-program compiler
    // logs force synchronous GPU round trips even when compilation succeeds.
    this.renderer.debug.checkShaderErrors = this.diagnostics;
    // Keep the public alias for diagnostics; there is only one GPU context and
    // one browser presentation now. Hardware AA is handled by its cached target.
    this.optics = this.renderer;
    this.renderer.domElement.id = 'display-hardware';
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    this.host.append(this.renderer.domElement);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.renderer.autoClear = false;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    if (environment) environment.mapping = THREE.EquirectangularReflectionMapping;
    this.scene.environment = environment;
    this.scene.environmentIntensity = 1.0;
    this.scene.environmentRotation.set(0, 1.2, 0);
    this.assembly = new THREE.Group();
    this.scene.add(this.assembly);
    this.models = {};
    this.glasses = [];
    // The glass sees a local cabin, not the studio used to capture the metal.
    const cabinPlate = this.deckTextures.values().next().value;
    this.reflections = new CabinReflections(this.renderer, cabinPlate);
    this.glassUniforms = {};
    for (let i = 0; i < 3; i++) {
      this.glassUniforms['reflection' + i] = { value: this.reflections.maps[i] };
      this.glassUniforms['reflectionMatrix' + i] = { value: this.reflections.matrices[i] };
    }
  }
  async initializeModels(models, environment) {
    await preparationPause();
    if (environment) RectAreaLightUniformsLib.init();
    for (const name of ['center', 'left', 'right']) {
      const model = models[name].scene;
      const pivot = new THREE.Group(),
        size = new THREE.Group();
      this.assembly.add(pivot);
      pivot.add(size);
      size.add(model);
      const entry = (this.models[name] = { model, pivot, size });
      model.traverse((object) => {
        if (!object.isMesh) return;
        // The monitor's silhouette casts the shadow, not every recessed screw.
        object.castShadow = false;
        object.receiveShadow = true;
        if (object.userData.part === 'fixed-hinge') {
          object.visible = false;
          return;
        }
        if (object.userData.part === 'optical-cover' || /optical.cover.glass/i.test(object.name)) {
          object.layers.set(1);
          object.castShadow = false;
          object.receiveShadow = false;
          object.material = this.makeGlass();
          this.glasses.push(object);
        } else if (
          object.userData.part === 'screen-substrate' ||
          /inset.*display|screen.*emission|luminous.*screen/i.test(object.name)
        ) {
          // The blue substrate emits a constant color; reflections belong to
          // its separate glass cover. It needs no five-light PBR evaluation.
          object.material = new THREE.MeshBasicMaterial({
            color: new THREE.Color(0x03283e).multiplyScalar(0.9),
          });
          object.castShadow = false;
          object.receiveShadow = false;
        } else {
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          for (const material of materials) {
            this.shareNormalTexture(material);
            // Keep the graphite structural shell distinct from the two silver
            // finishes. Its name also contains "satin", but it is not metal.
            if (/polished silver/i.test(material.name)) {
              material.metalness = 1;
              material.roughness = 0.19;
              material.envMapIntensity = 0.95;
            } else if (/satin aluminum/i.test(material.name)) {
              material.metalness = 0.94;
              material.roughness = 0.32;
              material.envMapIntensity = 1.05;
            }
          }
        }
      });
      await this.mergeHardware(model);
      this.makeShadowProxy(name, entry);
      const light = new THREE.RectAreaLight(0x68cfff, 3.4, 1, 1);
      light.layers.enable(1);
      entry.light = light;
      this.scene.add(light);
      await preparationPause();
    }
    const ambient = new THREE.HemisphereLight(0xc2e5ff, 0x343335, 1.0);
    ambient.layers.enable(1);
    this.scene.add(ambient);
    this.key = new THREE.DirectionalLight(0xe3f1ff, 2.1);
    this.key.castShadow = true;
    // Only three smooth monitor silhouettes cast here. A 1K map retains their
    // outline with the same world-space filter width, at one quarter the pixels.
    this.key.shadow.mapSize.set(1024, 1024);
    this.key.shadow.bias = -0.0001;
    this.key.shadow.normalBias = 0.3;
    this.key.layers.enable(1);
    this.scene.add(this.key, this.key.target);
    this.fill = new THREE.RectAreaLight(0xc4faff, 5.0, 800, 180);
    this.fill.layers.enable(1);
    this.scene.add(this.fill);
    this.warm = new THREE.RectAreaLight(0xffd9b4, 3.5, 350, 100);
    this.warm.layers.enable(1);
    this.scene.add(this.warm);
    const deckGeometry = new THREE.BufferGeometry();
    // Resolve the nearest structural surface first. The transparent shadow and
    // spill then cannot accumulate through overlapping bevels and back faces.
    this.receiverDepth = new THREE.Mesh(
      deckGeometry,
      new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }),
    );
    this.receiverDepth.renderOrder = -20;
    this.scene.add(this.receiverDepth);
    this.shadow = new THREE.Mesh(
      deckGeometry,
      new THREE.ShadowMaterial({
        color: 0x010711,
        opacity: 0.45,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    this.instrumentRect = { value: new THREE.Vector4() };
    this.spillUniforms = {
      sources: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
      normals: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
      powers: { value: [1, 1, 1] },
      screenAxes: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
      screenSizes: { value: [new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2()] },
    };
    this.shadow.material.onBeforeCompile = (shader) => {
      shader.uniforms.instrumentRect = this.instrumentRect;
      Object.assign(shader.uniforms, this.spillUniforms);
      for (const name of ['plate', 'cabinEdges', 'cabinOuter'])
        shader.uniforms[name] = this.reflections.uniforms[name];
      shader.vertexShader =
        'attribute float shadowStrength;attribute vec2 plateUv;varying float vStrength;varying vec2 vPlateUv;varying vec3 vWorld;varying vec3 vSurfaceNormal;\n' +
        shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvStrength=shadowStrength;vPlateUv=plateUv;vWorld=(modelMatrix*vec4(transformed,1.)).xyz;vSurfaceNormal=normalize(mat3(modelMatrix)*normal);',
      );
      shader.fragmentShader =
        `uniform vec4 instrumentRect;varying float vStrength;varying vec2 vPlateUv;varying vec3 vWorld;varying vec3 vSurfaceNormal;
        uniform vec3 sources[3];uniform vec3 normals[3];uniform float powers[3];uniform vec3 screenAxes[3];uniform vec2 screenSizes[3];
        uniform sampler2D plate;uniform vec4 cabinEdges;uniform vec2 cabinOuter;
        float originalCoordinate(float p,vec2 edges,vec2 source,vec2 outer){
          if(p<edges.x)return (p-outer.x)*source.x/(edges.x-outer.x);
          if(p<edges.y)return source.x+(p-edges.x)*(source.y-source.x)/(edges.y-edges.x);
          return source.y+(p-edges.y)*(1.-source.y)/(outer.y-edges.y);
        }
` + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <fog_fragment>',
        `vec2 panel=(vPlateUv-instrumentRect.xy)/instrumentRect.zw;
        float luminousFace=step(.035,panel.x)*step(panel.x,.965)*step(.17,panel.y)*step(panel.y,.81);
        // Instrument glass receives a shadow; only its luminous markings keep
        // emitting. Reuse the resident cabin texture, rather than a new mask.
        float emission=luminousFace;
        vec2 uv=vec2(originalCoordinate(vPlateUv.x,cabinEdges.xy,vec2(.3,.7),cabinOuter),
          originalCoordinate(vPlateUv.y,cabinEdges.zw,vec2(.11,.175),vec2(0.,1.)));
        vec3 radiance=texture2D(plate,vec2(uv.x,1.-uv.y)).rgb;
        if(vStrength<.99)emission=max(emission,smoothstep(.08,.6,max(radiance.r,max(radiance.g,radiance.b))));
        // The front light bar's warm bounce is not blocked by a screen behind
        // it. Preserve that baked contribution when the ceiling is occluded.
        emission=max(emission,smoothstep(.035,.3,radiance.r-radiance.b*1.25)*step(.838,uv.y));
        gl_FragColor.a*=vStrength*(1.-emission*.96);
        float energy=0.,reflection=0.;vec3 n=normalize(vSurfaceNormal)*(gl_FrontFacing?1.:-1.);
        vec3 view=normalize(cameraPosition-vWorld),reflected=reflect(-view,n);
        for(int i=0;i<3;i++){vec3 ray=vWorld-sources[i];float d2=max(dot(ray,ray),1600.);vec3 direction=normalize(ray);
          energy+=powers[i]*max(dot(direction,normals[i]),0.)*max(dot(-direction,n),0.)/d2;
          // Intersect the reflected ray with the actual emitting display plane.
          // A rough edge spreads its rectangular footprint on the brushed desk.
          float facing=dot(reflected,normals[i]);
          if(powers[i]>0.&&facing<-.001){
            float travel=dot(sources[i]-vWorld,normals[i])/facing;
            vec3 hit=vWorld+reflected*travel-sources[i];
            vec3 vertical=cross(normals[i],screenAxes[i]);
            vec2 offset=abs(vec2(dot(hit,screenAxes[i]),dot(hit,vertical)))-screenSizes[i]*.5;
            float blur=max(12.,abs(travel)*.14);
            vec2 coverage=1.-smoothstep(vec2(-blur),vec2(blur),offset);
            reflection+=coverage.x*coverage.y*step(0.,travel)*(.025+.075*pow(1.-max(dot(n,view),0.),3.));
          }
        }
        float spill=(.10*(1.-exp(-energy*2.))+reflection)*vStrength*(1.-emission*.9);
        float alpha=min(1.,gl_FragColor.a+spill);
        gl_FragColor=vec4((gl_FragColor.rgb*gl_FragColor.a+vec3(.16,.67,1.)*spill)/max(alpha,.00001),alpha);
        #include <fog_fragment>`,
      );
    };
    this.shadow.material.customProgramCacheKey = () => 'console-surface-shadow-v2';
    this.shadow.material.forceSinglePass = true;
    this.shadow.receiveShadow = true;
    this.scene.add(this.shadow);
    // Set up the shared geometry and lights without compiling or drawing PBR
    // hardware. Normal visits replace those materials with stored captures first.
    this.makeMounts();
    this.makeComposite();
    if (this.layout()) this.updatePose();
    this.installContextRecovery();
    this.resizeObserver = new ResizeObserver(() => {
      this.layoutDirty = true;
      if (this.hinges.physical === this) this.hinges.render();
    });
    for (const element of [this.neutral, this.stage, this.displayStage])
      this.resizeObserver.observe(element);
    this.resumeLayout = () => {
      if (!document.hidden && this.layoutDirty && this.hinges.physical === this)
        this.hinges.render();
    };
    document.addEventListener('visibilitychange', this.resumeLayout);
  }
  shareNormalTexture(material) {
    const texture = material.normalMap;
    if (!texture) return;
    // These three exports contain the same normal image. Preserve per-texture
    // UV transforms, while sharing a single GPU texture for identical settings.
    const key = [
      texture.wrapS,
      texture.wrapT,
      texture.repeat.x,
      texture.repeat.y,
      texture.offset.x,
      texture.offset.y,
      texture.center.x,
      texture.center.y,
      texture.rotation,
      texture.channel,
      texture.flipY,
    ].join(',');
    const shared = this.normalTextures.get(key);
    if (shared && shared !== texture) {
      material.normalMap = shared;
      texture.dispose();
    } else if (!shared) this.normalTextures.set(key, texture);
  }
  async mergeHardware(model) {
    model.updateMatrixWorld(true);
    const inverse = new THREE.Matrix4().copy(model.matrixWorld).invert(),
      buckets = new Map(),
      removed = [];
    model.traverse((object) => {
      if (!object.isMesh) return;
      if (object.userData.part === 'fixed-hinge') {
        removed.push(object);
        return;
      }
      if (object.userData.part !== 'hardware' || Array.isArray(object.material)) return;
      // Matching attributes and material retain every visible vertex, normal,
      // UV and finish, with one draw call for each finish on each device.
      const signature = Object.keys(object.geometry.attributes)
        .sort()
        .map(
          (key) =>
            `${key}:${object.geometry.attributes[key].itemSize}:${object.geometry.attributes[key].normalized}`,
        )
        .join(',');
      const key = object.material.uuid + '|' + signature + '|' + !!object.geometry.index;
      if (!buckets.has(key)) buckets.set(key, { material: object.material, objects: [] });
      buckets.get(key).objects.push(object);
    });
    const checkpoint = preparationBudget();
    for (const { material, objects } of buckets.values()) {
      if (objects.length < 2) continue;
      const geometries = [];
      for (const object of objects) {
        geometries.push(
          object.geometry
            .clone()
            .applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, object.matrixWorld)),
        );
        const pause = checkpoint();
        if (pause) await pause;
      }
      const geometry = mergeGeometries(geometries, false);
      for (const copy of geometries) copy.dispose();
      if (!geometry) continue;
      const merged = new THREE.Mesh(geometry, material);
      merged.name = 'Merged / ' + material.name;
      merged.receiveShadow = true;
      merged.userData.part = 'hardware';
      model.add(merged);
      removed.push(...objects);
      const pause = checkpoint();
      if (pause) await pause;
    }
    for (const object of removed) {
      object.removeFromParent();
      object.geometry.dispose();
    }
  }
  makeShadowProxy(name, entry) {
    const d = this.dims(name),
      bounds = this.metadata.models[name].bounds,
      depth = bounds.max[2] - bounds.min[2];
    const material = new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: false,
      depthTest: false,
    });
    const proxy = new THREE.Mesh(new THREE.BoxGeometry(d.width, d.height, depth), material);
    proxy.name = name + ' / shadow silhouette';
    proxy.position.set(0, d.height / 2, (bounds.min[2] + bounds.max[2]) / 2);
    proxy.castShadow = true;
    proxy.renderOrder = -1;
    entry.size.add(proxy);
  }
  makeComposite() {
    const hdr = this.renderer.extensions.has('EXT_color_buffer_float');
    const gl = this.renderer.getContext();
    const colorSamples = gl.getInternalformatParameter(
      gl.RENDERBUFFER,
      hdr ? gl.RGBA16F : gl.RGBA8,
      gl.SAMPLES,
    );
    const depthSamples = gl.getInternalformatParameter(
      gl.RENDERBUFFER,
      gl.DEPTH_COMPONENT24,
      gl.SAMPLES,
    );
    // Resolve enough coverage samples to keep the thin, high-contrast bezel
    // bands continuous. Respect support for this color AND depth format.
    this.supportedSamples = Array.from(colorSamples).filter(
      (n) => n <= 8 && depthSamples.includes(n),
    );
    // The entrance moves every joint while the view is intentionally defocused.
    // Two coverage samples avoid queueing eight full HDR/depth buffers per
    // moving frame. The settled cockpit restores its original sample budget.
    const samples = Math.max(0, ...this.supportedSamples.filter((n) => n <= 2));
    this.hardwareTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false,
      resolveDepthBuffer: false,
      samples,
    });
    // Erase the exact glass aperture after the hardware pass. A transparent
    // material would retain the blue substrate underneath; zero/zero blending
    // removes both color and alpha so native HTML remains visible below canvas.
    this.apertureMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.FrontSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.ZeroFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.ZeroFactor,
      vertexShader: 'void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
      fragmentShader: 'void main(){gl_FragColor=vec4(0.);}',
    });
    this.apertures = [];
    for (const glass of this.glasses) {
      const aperture = glass.clone(false);
      aperture.material = this.apertureMaterial;
      aperture.layers.set(0);
      aperture.renderOrder = 10000;
      aperture.name = 'HTML aperture / ' + glass.name;
      glass.parent.add(aperture);
      this.apertures.push(aperture);
    }
    this.compositeMaterial = new THREE.ShaderMaterial({
      uniforms: { hardware: { value: this.hardwareTarget.texture } },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      toneMapped: true,
      vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}',
      fragmentShader: `uniform sampler2D hardware;varying vec2 vUv;
        void main(){vec4 value=texture2D(hardware,vUv);
          // Render-target blending stores premultiplied linear color. Apply
          // exposure/ACES and sRGB once to straight color, then restore alpha.
          gl_FragColor=vec4(value.rgb/max(value.a,.00001),value.a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          gl_FragColor.rgb*=gl_FragColor.a;
        }`,
    });
    this.compositeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compositeMaterial);
    // Its vertex shader writes clip-space coordinates directly. Draw this
    // opaque copy first, then the transparent glass covers, in one pass.
    this.compositeQuad.frustumCulled = false;
    this.compositeQuad.layers.set(1);
    this.compositeQuad.renderOrder = -10000;
    // Reflection-only frames need just two draws. The glass has one shared
    // shader; retain its source proxies for pose/order metadata and concatenate
    // their exact transformed vertices into a small dynamic world-space mesh.
    this.opticsScene = new THREE.Scene();
    this.opticsScene.matrixWorldAutoUpdate = false;
    this.opticsScene.add(this.compositeQuad);
    this.opticalCovers = this.glasses.map((glass) => {
      const cover = new THREE.Mesh(glass.geometry, glass.material);
      cover.name = 'Optics / ' + glass.name;
      cover.layers.set(1);
      cover.matrixAutoUpdate = false;
      cover.matrixWorldAutoUpdate = false;
      return cover;
    });
    let vertices = 0,
      indices = 0;
    this.opticalParts = this.opticalCovers.map((cover) => {
      const geometry = cover.geometry;
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const part = {
        cover,
        vertexStart: vertices,
        indexStart: indices,
        indexCount: geometry.index?.count ?? geometry.attributes.position.count,
        center: new THREE.Vector3(),
        order: 0,
        visible: true,
      };
      vertices += geometry.attributes.position.count;
      indices += part.indexCount;
      return part;
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage),
    );
    geometry.setAttribute(
      'normal',
      new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage),
    );
    const reflectionIds = new Float32Array(vertices);
    for (const [i, part] of this.opticalParts.entries())
      reflectionIds.fill(
        i,
        part.vertexStart,
        part.vertexStart + part.cover.geometry.attributes.position.count,
      );
    geometry.setAttribute('reflectionId', new THREE.BufferAttribute(reflectionIds, 1));
    // Stable coordinates belong to the glass itself, before its hinge/tilt.
    // A narrow optical perimeter can then follow the exact projected surface.
    const glassUV = new Float32Array(vertices * 2);
    for (const part of this.opticalParts) {
      const source = part.cover.geometry,
        p = source.attributes.position,
        b = source.boundingBox;
      for (let j = 0; j < p.count; j++) {
        const at = (part.vertexStart + j) * 2;
        glassUV[at] = (p.getX(j) - b.min.x) / (b.max.x - b.min.x);
        glassUV[at + 1] = (p.getY(j) - b.min.y) / (b.max.y - b.min.y);
      }
    }
    geometry.setAttribute('glassUV', new THREE.BufferAttribute(glassUV, 2));
    geometry.setIndex(
      new THREE.BufferAttribute(new Uint16Array(indices), 1).setUsage(THREE.DynamicDrawUsage),
    );
    this.opticalMesh = new THREE.Mesh(geometry, this.opticalCovers[0].material);
    this.opticalMesh.name = 'Combined world-space optical covers';
    this.opticalMesh.layers.set(1);
    this.opticalMesh.frustumCulled = false;
    this.opticalMesh.matrixAutoUpdate = false;
    this.opticalMesh.matrixWorldAutoUpdate = false;
    this.opticsScene.add(this.opticalMesh);
    this.opticalOrderKey = '';
  }
  updateOpticalCovers(changed) {
    const geometry = this.opticalMesh.geometry,
      positions = geometry.attributes.position,
      normals = geometry.attributes.normal;
    for (const [i, name] of ['center', 'left', 'right'].entries()) {
      const part = this.opticalParts[i],
        cover = part.cover,
        source = this.glasses[i];
      if (changed[name]) {
        cover.matrixWorld.copy(source.matrixWorld);
        const e = source.matrixWorld.elements,
          p = source.geometry.attributes.position,
          n = source.geometry.attributes.normal;
        const normalMatrix = new THREE.Matrix3().getNormalMatrix(source.matrixWorld).elements;
        for (let j = 0; j < p.count; j++) {
          const x = p.getX(j),
            y = p.getY(j),
            z = p.getZ(j),
            at = part.vertexStart + j;
          positions.setXYZ(
            at,
            e[0] * x + e[4] * y + e[8] * z + e[12],
            e[1] * x + e[5] * y + e[9] * z + e[13],
            e[2] * x + e[6] * y + e[10] * z + e[14],
          );
          // Nonuniform responsive scaling must not bend the reflected normal.
          const nx = n.getX(j),
            ny = n.getY(j),
            nz = n.getZ(j),
            a = normalMatrix[0] * nx + normalMatrix[3] * ny + normalMatrix[6] * nz,
            b = normalMatrix[1] * nx + normalMatrix[4] * ny + normalMatrix[7] * nz,
            c = normalMatrix[2] * nx + normalMatrix[5] * ny + normalMatrix[8] * nz;
          const length = Math.hypot(a, b, c) || 1;
          normals.setXYZ(at, a / length, b / length, c / length);
        }
        positions.addUpdateRange(part.vertexStart * 3, p.count * 3);
        normals.addUpdateRange(part.vertexStart * 3, n.count * 3);
        positions.needsUpdate = true;
        normals.needsUpdate = true;
      }
      // Match Three's back-to-front transparent object order. Each source's
      // triangles retain their original order, winding, and FrontSide culling.
      part.order = part.center
        .copy(cover.geometry.boundingSphere.center)
        .applyMatrix4(cover.matrixWorld)
        .project(this.renderCamera).z;
      let visible = cover.visible;
      for (let ancestor = source; ancestor; ancestor = ancestor.parent)
        if (!ancestor.visible) {
          visible = false;
          break;
        }
      part.visible = visible;
    }
    const ordered = this.opticalParts
      .filter((part) => part.visible)
      .sort(
        (a, b) =>
          a.cover.renderOrder - b.cover.renderOrder || b.order - a.order || a.cover.id - b.cover.id,
      );
    const orderKey = ordered.map((part) => part.cover.id).join(',');
    if (orderKey !== this.opticalOrderKey) {
      let offset = 0;
      for (const part of ordered) {
        const source = part.cover.geometry.index;
        for (let i = 0; i < part.indexCount; i++)
          geometry.index.setX(offset++, part.vertexStart + (source ? source.getX(i) : i));
      }
      geometry.setDrawRange(0, offset);
      geometry.index.needsUpdate = true;
      this.opticalOrderKey = orderKey;
    }
  }
  finishKey(source) {
    // Only properties captured into the lighting texture belong here. Runtime
    // UUIDs and normal maps are deliberately excluded so exports are reusable.
    return JSON.stringify([
      source.name,
      source.color.getHexString(),
      source.emissive.getHexString(),
      source.emissiveIntensity,
      source.metalness,
      source.roughness,
      source.envMapIntensity,
      source.clearcoat || 0,
      source.clearcoatRoughness || 0,
    ]);
  }
  capturedMaterial(source, texture) {
    const material = new THREE.MeshMatcapMaterial({
      name: 'Captured / ' + source.name,
      color: 0xffffff,
      matcap: texture,
      normalMap: source.normalMap,
      normalScale: source.normalScale.clone(),
      normalMapType: source.normalMapType,
      side: source.side,
      transparent: source.transparent,
      opacity: source.opacity,
      depthWrite: source.depthWrite,
      alphaTest: source.alphaTest,
      toneMapped: true,
    });
    // Gain, black point, neutral-silver mix and angular highlight strength.
    // The silver face keeps its dark channel; only its curved normal catches
    // the bright roll. Emissive guides and graphite never acquire this glint.
    const response = /polished silver/i.test(source.name)
      ? [1.25, 0.008, 0.82, 1]
      : /satin aluminum/i.test(source.name)
        ? [1.08, 0.006, 0.5, 0.42]
        : /structural shell/i.test(source.name)
          ? [0.94, 0.002, 0.2, 0]
          : /device backs|brushed graphite/i.test(source.name)
            ? [0.74, 0.008, 0.2, 0]
            : /gaskets|soft black/i.test(source.name)
              ? [0.86, 0.004, 0.12, 0]
              : [1, 0, 0, 0];
    material.userData.finishResponse = response;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.finishResponse = { value: new THREE.Vector4().fromArray(response) };
      shader.fragmentShader = 'uniform vec4 finishResponse;\n' + shader.fragmentShader;
      polishFinishShader(shader, 'finishResponse');
    };
    material.customProgramCacheKey = () => 'captured-finish-polish-v2';
    return material;
  }
  static async fetchHardwareFinishes() {
    const packed =
      typeof DecompressionStream === 'function'
        ? loadPackedBytes(displayAsset('finishes/finishes.pixels.gz')).catch(() => null)
        : Promise.resolve(null);
    const response = await fetch(displayAsset('finishes/manifest.json'));
    if (!response.ok) throw new Error('Captured hardware finishes unavailable');
    const manifest = await response.json();
    if (manifest.version !== 1 || !Array.isArray(manifest.finishes))
      throw new Error('Unsupported hardware finish manifest');
    for (const entry of manifest.finishes)
      if (typeof entry.key !== 'string' || !/^finish-\d+\.hdr$/.test(entry.file))
        throw new Error('Invalid captured hardware finish');
    const loader = new HDRLoader(),
      textures = new Map();
    const bundle = await packed;
    let pixelFiles;
    if (bundle)
      try {
        pixelFiles = await decodeFinishes(bundle, manifest);
        // Keep the existing compatibility path if workers are blocked.
        if (!pixelFiles) pixelFiles = unpackFinishPixels(bundle, manifest);
      } catch {
        /* Use the original captured HDRs below. */
      }
    const files = new Map();
    const fallbackBundle =
      !pixelFiles && typeof DecompressionStream === 'function'
        ? await loadPackedBytes(displayAsset('finishes/finishes.pack.gz')).catch(() => null)
        : null;
    if (fallbackBundle)
      try {
        const bundle = fallbackBundle;
        const length = new DataView(bundle).getUint32(0, true);
        const inventory = JSON.parse(new TextDecoder().decode(new Uint8Array(bundle, 4, length)));
        if (inventory.version !== 1 || inventory.files.length !== manifest.finishes.length)
          throw Error('Invalid finish inventory');
        let offset = 4 + length;
        for (const file of inventory.files) {
          if (
            !Number.isSafeInteger(file.bytes) ||
            file.bytes <= 0 ||
            offset + file.bytes > bundle.byteLength ||
            files.has(file.file) ||
            !manifest.finishes.some((entry) => entry.file === file.file)
          )
            throw Error('Invalid finish payload');
          files.set(file.file, bundle.slice(offset, offset + file.bytes));
          offset += file.bytes;
        }
        if (offset !== bundle.byteLength) throw Error('Invalid finish length');
      } catch {
        files.clear();
      }
    // Fetch and decode alongside the GLBs. These CPU textures do not need a
    // renderer or model yet. Drain failures before disposing the partial set.
    const loaded = await Promise.allSettled(
      manifest.finishes.map(async (entry) => {
        let texture;
        if (pixelFiles?.has(entry.file)) {
          const { width, height, pixels, half: decoded } = pixelFiles.get(entry.file);
          // Match HDRLoader's RGBE -> half-float conversion exactly, including
          // saturation and opaque alpha. No color-range or resolution reduction.
          const half = decoded || finishPixelsToHalfFloat(pixels, THREE.DataUtils.toHalfFloat);
          texture = new THREE.DataTexture(
            half,
            width,
            height,
            THREE.RGBAFormat,
            THREE.HalfFloatType,
          );
          texture.flipY = true;
          texture.magFilter = THREE.LinearFilter;
          texture.needsUpdate = true;
        } else if (files.has(entry.file)) {
          const data = loader.parse(files.get(entry.file));
          texture = new THREE.DataTexture(
            data.data,
            data.width,
            data.height,
            THREE.RGBAFormat,
            data.type,
          );
          texture.flipY = true;
          texture.magFilter = THREE.LinearFilter;
          texture.needsUpdate = true;
        } else texture = await loader.loadAsync(displayAsset('finishes/' + entry.file));
        texture.colorSpace = THREE.LinearSRGBColorSpace;
        texture.generateMipmaps = true;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        textures.set(entry.key, texture);
      }),
    );
    const failure = loaded.find((result) => result.status === 'rejected');
    if (failure) {
      for (const texture of textures.values()) texture.dispose();
      throw failure.reason;
    }
    performance.mark('cockpit-finish-data-ready');
    return { manifest, textures };
  }
  async loadHardwareFinishes(prepared) {
    const { manifest, textures } = prepared || (await PhysicalConsole.fetchHardwareFinishes());
    for (const texture of textures.values()) this.finishTextures.add(texture);
    // The finish atlas reads these retained CPU pixels and uploads them once.
    // Avoid uploading twelve redundant textures and mip chains beforehand.
    // Any non-atlas fallback material still gets Three's normal lazy upload.
    const materials = new Map(),
      objects = [];
    this.scene.traverse((object) => {
      if (
        object.isMesh &&
        !Array.isArray(object.material) &&
        object.material.isMeshStandardMaterial
      )
        objects.push(object);
    });
    for (const object of objects)
      if (!textures.has(this.finishKey(object.material)))
        throw new Error('A captured hardware finish is missing');
    for (const object of objects) {
      const source = object.material;
      if (!materials.has(source))
        materials.set(source, this.capturedMaterial(source, textures.get(this.finishKey(source))));
      object.material = materials.get(source);
    }
    for (const source of materials.keys()) source.dispose();
    this.finishManifest = manifest.finishes;
    this.stats.bakedFinishes = 0;
    this.stats.loadedFinishes = textures.size;
    this.poseKey = '';
  }
  async bakeHardwareFinishes() {
    // Capture the approved PBR finish once. Matcaps retain its colored metal
    // highlights and Fresnel response as each normal turns toward the viewer,
    // without evaluating five area lights on every moving hardware fragment.
    const scene = new THREE.Scene();
    scene.environment = this.scene.environment;
    // The captured studio has a broad upper key and a quieter frontal fill.
    // This preserves a silver midtone on flat machined faces while the real
    // rounded bevel normals pick up bright highlights. It is baked once.
    scene.environmentIntensity = 0.42;
    scene.environmentRotation.copy(this.scene.environmentRotation);
    for (const source of this.scene.children.filter((object) => object.isLight)) {
      const light = source.clone();
      light.castShadow = false;
      scene.add(light);
      if (light.isDirectionalLight) {
        light.target = source.target.clone();
        scene.add(light.target);
      }
      if (source === this.fill) light.intensity = 0.75;
      else if (source === this.warm) light.intensity = 1.2;
      else if (light.isHemisphereLight) light.intensity = 0.65;
    }
    const position = this.assembly.position
      .clone()
      .add(new THREE.Vector3(0, this.rect.height * 0.55, 0));
    const camera = new THREE.OrthographicCamera(-1 / 0.99, 1 / 0.99, 1 / 0.99, -1 / 0.99, 0.1, 10);
    camera.position.copy(position).add(new THREE.Vector3(0, 0, 4));
    camera.lookAt(position);
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32));
    sphere.position.copy(position);
    scene.add(sphere);
    const finishes = new Map(),
      materials = new Map(),
      objects = [],
      sourceMaterials = new Set();
    this.scene.traverse((object) => {
      if (
        object.isMesh &&
        !Array.isArray(object.material) &&
        object.material.isMeshStandardMaterial
      )
        objects.push(object);
    });
    const shadowEnabled = this.renderer.shadowMap.enabled;
    this.renderer.shadowMap.enabled = false;
    try {
      for (const object of objects) {
        const source = object.material;
        sourceMaterials.add(source);
        const key = this.finishKey(source);
        let texture = finishes.get(key);
        if (!texture) {
          const target = new THREE.WebGLRenderTarget(256, 256, {
            type: this.hardwareTarget.texture.type,
            format: THREE.RGBAFormat,
            colorSpace: THREE.LinearSRGBColorSpace,
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            generateMipmaps: false,
            depthBuffer: true,
            stencilBuffer: false,
          });
          const index = this.matcapTargets.length;
          this.matcapTargets.push(target);
          this.finishManifest.push({
            key,
            name: source.name,
            index,
            file: `finish-${String(index + 1).padStart(2, '0')}.hdr`,
          });
          const capture = source.clone();
          capture.normalMap = null;
          capture.normalScale.set(0, 0);
          capture.transparent = false;
          capture.opacity = 1;
          sphere.material = capture;
          this.renderer.setRenderTarget(target);
          this.renderer.clear(true, true, true);
          await this.renderer.compileAsync(scene, camera);
          this.renderer.render(scene, camera);
          capture.dispose();
          texture = target.texture;
          finishes.set(key, texture);
        }
        if (!materials.has(source)) materials.set(source, this.capturedMaterial(source, texture));
        object.material = materials.get(source);
      }
      this.stats.bakedFinishes = finishes.size;
      this.poseKey = '';
    } finally {
      this.renderer.shadowMap.enabled = shadowEnabled;
      this.renderer.setRenderTarget(null);
      sphere.geometry.dispose();
      for (const material of sourceMaterials) material.dispose();
    }
  }
  async makeFinishAtlas(sources) {
    const checkpoint = preparationBudget();
    const textures = [...new Set(sources.map((source) => source.material.matcap))];
    if (!textures.length) return null;
    const first = textures[0],
      width = first?.image?.width,
      height = first?.image?.height;
    if (
      !width ||
      !height ||
      first.format !== THREE.RGBAFormat ||
      textures.some(
        (texture) =>
          !texture ||
          texture.image?.width !== width ||
          texture.image?.height !== height ||
          texture.type !== first.type ||
          texture.format !== first.format ||
          texture.colorSpace !== THREE.LinearSRGBColorSpace,
      )
    )
      return null;
    // Saved HDRs only need the same texture sampling as the original materials.
    // Explicit developer readback additionally needs float color attachments.
    if (
      textures.some((texture) => texture.isRenderTargetTexture) &&
      (first.type === THREE.HalfFloatType || first.type === THREE.FloatType) &&
      !this.renderer.extensions.has('EXT_color_buffer_float')
    )
      return null;
    const gl = this.renderer.getContext();
    if (
      Math.max(width, height) > this.renderer.capabilities.maxTextureSize ||
      textures.length > gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS)
    )
      return null;
    const ArrayType =
      first.type === THREE.HalfFloatType
        ? Uint16Array
        : first.type === THREE.FloatType
          ? Float32Array
          : Uint8Array;
    const pixels = new ArrayType(textures.length * width * height * 4),
      stride = width * 4,
      layerStride = width * height * 4;
    for (let i = 0; i < textures.length; i++) {
      const texture = textures[i];
      let source = texture.image.data;
      if (texture.isRenderTargetTexture) {
        // Only explicit developer captures need a readback. Ordinary visits
        // already hold all twelve HDR arrays; there is no GPU copy or readback.
        const target = this.matcapTargets.find((target) => target.texture === texture);
        if (!target) return null;
        source = new ArrayType(width * height * 4);
        this.renderer.readRenderTargetPixels(target, 0, 0, width, height, source);
      }
      if (!source || source.length !== width * height * 4) return null;
      for (let row = 0; row < height; row++) {
        const from = (texture.flipY ? height - 1 - row : row) * stride;
        pixels.set(source.subarray(from, from + stride), i * layerStride + row * stride);
        if ((row & 31) === 31) {
          const pause = checkpoint();
          if (pause) await pause;
        }
      }
    }
    // A retained CPU backing makes native WebGL context restoration reliable.
    // Three r180's copyTextureToTexture scratch framebuffer handles are created
    // once and become invalid after context loss; avoid that restoration path.
    // Independent texture layers keep each finish's mip chain isolated. A
    // tiled atlas cannot filter subpixel reflections without neighboring
    // finishes bleeding into the sampled metal highlights.
    const atlas = new THREE.DataArrayTexture(pixels, width, height, textures.length);
    atlas.format = first.format;
    atlas.type = first.type;
    atlas.name = 'Filtered captured finish layers';
    atlas.colorSpace = THREE.LinearSRGBColorSpace;
    atlas.generateMipmaps = true;
    atlas.minFilter = THREE.LinearMipmapLinearFilter;
    atlas.magFilter = THREE.LinearFilter;
    atlas.needsUpdate = true;
    this.finishAtlas = atlas;
    this.renderer.initTexture(atlas);
    this.installContextRecovery();
    this.stats.hardwareAtlasFinishes = textures.length;
    return { texture: atlas, indices: new Map(textures.map((texture, i) => [texture, i])) };
  }
  installContextRecovery() {
    if (this.restoreContext) return;
    this.loseContext = () => {
      this.contextLost = true;
      // Release target listeners through the old texture manager while its GL
      // context is lost. Otherwise a later resize can dispose stale framebuffer
      // handles retained by that manager after Three initializes a new one.
      this.renderer.setRenderTarget(null);
      for (const target of new Set([
        this.hardwareTarget,
        ...this.reflections.targets,
        ...this.matcapTargets,
        this.key.shadow.map,
        this.key.shadow.mapPass,
      ]))
        target?.dispose();
      const geometries = new Set();
      for (const scene of [this.scene, this.opticsScene, this.reflections.scene])
        scene.traverse((object) => {
          if (object.geometry) geometries.add(object.geometry);
        });
      // dispose releases GPU buffers/listeners, retaining the CPU geometry for
      // automatic upload on restoration and later responsive replacements.
      for (const geometry of geometries) geometry.dispose();
      this.reflections.invalidate();
    };
    this.restoreContext = () => {
      this.contextLost = false;
      if (this.finishAtlas) {
        this.finishAtlas.needsUpdate = true;
        this.renderer.initTexture(this.finishAtlas);
      }
      // Reapply transparent clear state after Three rebuilds its GL state cache.
      // Its retained public clear color alone does not initialize the new cache.
      this.renderer.setClearColor(0x000000, 0);
      // Render targets lose their pixels even when no pose or lighting changes.
      // Repaint both passes, including devices using the non-atlas fallback.
      this.poseKey = '';
      this.lightingKey = '';
      this.reflections.invalidate();
      if (this.hinges.physical === this) this.hinges.render();
    };
    this.renderer.domElement.addEventListener('webglcontextlost', this.loseContext);
    this.renderer.domElement.addEventListener('webglcontextrestored', this.restoreContext);
  }
  atlasMaterial(source, atlas, normalMap) {
    const material = source.clone();
    material.name = 'Atlased / ' + source.name;
    material.matcap = atlas.texture;
    material.color.set(0xffffff);
    material.normalMap = normalMap;
    material.normalMapType = THREE.TangentSpaceNormalMap;
    material.onBeforeCompile = (shader) => {
      shader.vertexShader =
        'attribute vec4 finishData;attribute vec3 finishColor;attribute vec4 finishResponse;varying vec4 vFinishData;varying vec3 vFinishColor;varying vec4 vFinishResponse;\n' +
        shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <uv_vertex>',
        '#include <uv_vertex>\nvFinishData=finishData;vFinishColor=finishColor;vFinishResponse=finishResponse;',
      );
      shader.fragmentShader =
        'varying vec4 vFinishData;varying vec3 vFinishColor;varying vec4 vFinishResponse;\n' +
        shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        'vec4 diffuseColor = vec4( diffuse * vFinishColor, opacity );',
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_maps>',
        'if(vFinishData.w>.5){\n' +
          THREE.ShaderChunk.normal_fragment_maps.replace(
            'mapN.xy *= normalScale;',
            'mapN.xy *= vFinishData.yz;',
          ) +
          '\n}',
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        'uniform sampler2D matcap;',
        'uniform highp sampler2DArray matcap;',
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        'texture2D( matcap, uv )',
        'texture( matcap, vec3(uv,vFinishData.x) )',
      );
      polishFinishShader(shader, 'vFinishResponse');
    };
    material.customProgramCacheKey = () => 'captured-finish-layers-polish-v4';
    this.finishAtlasMaterials.add(material);
    return material;
  }
  async atlasGeometry(source, atlas, uvAttributes, checkpoint) {
    const geometry = source.geometry.clone(),
      count = geometry.attributes.position.count,
      material = source.material;
    // Retain every original vertex/index/UV. Missing, unused UV channels get
    // zeroes solely to give every source the same immutable batch layout.
    for (const name of uvAttributes)
      if (!geometry.hasAttribute(name))
        geometry.setAttribute(
          name,
          new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2),
        );
    const finish = new Float32Array(count * 4),
      color = new Float32Array(count * 3),
      response = new Float32Array(count * 4),
      index = atlas.indices.get(material.matcap);
    const profile = material.userData.finishResponse || [1, 0, 0, 0];
    for (let i = 0; i < count; i++) {
      finish[i * 4] = index;
      finish[i * 4 + 1] = material.normalScale.x;
      finish[i * 4 + 2] = material.normalScale.y;
      finish[i * 4 + 3] = material.normalMap ? 1 : 0;
      material.color.toArray(color, i * 3);
      response.set(profile, i * 4);
      if ((i & 2047) === 2047) {
        const pause = checkpoint();
        if (pause) await pause;
      }
    }
    geometry.setAttribute('finishData', new THREE.BufferAttribute(finish, 4));
    geometry.setAttribute('finishColor', new THREE.BufferAttribute(color, 3));
    geometry.setAttribute('finishResponse', new THREE.BufferAttribute(response, 4));
    return geometry;
  }
  async batchHardware() {
    const checkpoint = preparationBudget();
    const buckets = new Map();
    // These are the complete finish/normal settings produced by capturedMaterial.
    // Different attribute layouts or raster settings stay in separate batches.
    const rasterKeys = [
      'side',
      'opacity',
      'transparent',
      'depthWrite',
      'depthTest',
      'depthFunc',
      'colorWrite',
      'alphaTest',
      'alphaHash',
      'alphaToCoverage',
      'toneMapped',
      'vertexColors',
      'flatShading',
      'fog',
      'blending',
      'blendSrc',
      'blendDst',
      'blendEquation',
      'premultipliedAlpha',
      'polygonOffset',
      'polygonOffsetFactor',
      'polygonOffsetUnits',
      'wireframe',
    ];
    this.scene.traverse((source) => {
      const material = source.material,
        geometry = source.geometry;
      if (
        !source.isMesh ||
        source.isBatchedMesh ||
        !material?.isMeshMatcapMaterial ||
        material.transparent ||
        source.layers.mask !== 1 ||
        source.children.length
      )
        return;
      if (
        source.isSkinnedMesh ||
        Object.keys(geometry.morphAttributes).length ||
        material.clippingPlanes?.length
      )
        return;
      const count = geometry.index?.count ?? geometry.attributes.position.count;
      if (
        geometry.drawRange.start !== 0 ||
        (Number.isFinite(geometry.drawRange.count) && geometry.drawRange.count !== count)
      )
        return;
      // Three's batching normal transform supports positive, orthogonal scales.
      // Preserve the original draw for a future asset with reflection or shear.
      const e = source.matrixWorld.elements,
        sx = e[0] * e[0] + e[1] * e[1] + e[2] * e[2],
        sy = e[4] * e[4] + e[5] * e[5] + e[6] * e[6],
        sz = e[8] * e[8] + e[9] * e[9] + e[10] * e[10];
      if (
        source.matrixWorld.determinant() <= 0 ||
        sx === 0 ||
        sy === 0 ||
        sz === 0 ||
        Math.abs(e[0] * e[4] + e[1] * e[5] + e[2] * e[6]) > 1e-6 * Math.sqrt(sx * sy) ||
        Math.abs(e[0] * e[8] + e[1] * e[9] + e[2] * e[10]) > 1e-6 * Math.sqrt(sx * sz) ||
        Math.abs(e[4] * e[8] + e[5] * e[9] + e[6] * e[10]) > 1e-6 * Math.sqrt(sy * sz)
      )
        return;
      const attributes = Object.keys(geometry.attributes)
        .sort()
        .map((name) => {
          const a = geometry.attributes[name];
          return [
            name,
            a.itemSize,
            a.normalized,
            a.array?.constructor.name ?? a.data.array.constructor.name,
          ];
        });
      const key = JSON.stringify([
        material.matcap?.id,
        material.normalMap?.id,
        material.normalScale.toArray(),
        material.normalMapType,
        material.color.toArray(),
        rasterKeys.map((name) => material[name]),
        attributes,
        !!geometry.index,
        source.renderOrder,
        source.receiveShadow,
      ]);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(source);
    });
    const candidates = [...buckets.values()].flat(),
      eligible = candidates.filter((source) => {
        const m = source.material,
          g = source.geometry;
        return (
          m.matcap &&
          !m.vertexColors &&
          !m.map &&
          !m.alphaMap &&
          !m.bumpMap &&
          !m.displacementMap &&
          (!m.normalMap ||
            (m.normalMapType === THREE.TangentSpaceNormalMap &&
              m.normalMap.channel === 0 &&
              g.hasAttribute('uv'))) &&
          Object.entries(g.attributes).every(
            ([name, a]) =>
              /^(position|normal|uv[123]?)$/.test(name) &&
              a.array?.constructor.name === 'Float32Array' &&
              !a.normalized,
          ) &&
          g.hasAttribute('normal')
        );
      });
    const atlas = await this.makeFinishAtlas(eligible),
      groups = [];
    if (atlas) {
      const selected = new Set(eligible),
        rasterGroups = new Map();
      for (const source of eligible) {
        const key = JSON.stringify([
          rasterKeys.map((name) => source.material[name]),
          !!source.geometry.index,
          source.renderOrder,
          source.receiveShadow,
        ]);
        if (!rasterGroups.has(key)) rasterGroups.set(key, []);
        rasterGroups.get(key).push(source);
      }
      for (const sources of rasterGroups.values()) {
        const normalMaps = [
          ...new Set(sources.map((source) => source.material.normalMap).filter(Boolean)),
        ];
        if (normalMaps.length <= 1)
          groups.push({ sources, atlas, normalMap: normalMaps[0] || null });
        else
          for (const normalMap of [null, ...normalMaps])
            groups.push({
              sources: sources.filter((source) => source.material.normalMap === normalMap),
              atlas,
              normalMap,
            });
      }
      for (const sources of buckets.values())
        groups.push({ sources: sources.filter((source) => !selected.has(source)) });
    } else for (const sources of buckets.values()) groups.push({ sources });
    for (const { sources, atlas, normalMap } of groups) {
      if (sources.length < 2) continue;
      const uvAttributes = atlas
        ? [
            ...new Set([
              'uv',
              ...sources.flatMap((source) =>
                Object.keys(source.geometry.attributes).filter((name) => name.startsWith('uv')),
              ),
            ]),
          ]
        : [];
      const sourceGeometries = new Map();
      for (const source of sources) {
        sourceGeometries.set(
          source,
          atlas
            ? await this.atlasGeometry(source, atlas, uvAttributes, checkpoint)
            : source.geometry,
        );
        const pause = checkpoint();
        if (pause) await pause;
      }
      const geometries = [...new Set(sourceGeometries.values())];
      const vertices = geometries.reduce(
        (sum, geometry) => sum + geometry.attributes.position.count,
        0,
      );
      const indices = geometries.reduce((sum, geometry) => sum + (geometry.index?.count || 0), 0);
      const batch = new THREE.BatchedMesh(
        sources.length,
        vertices,
        indices,
        atlas ? this.atlasMaterial(sources[0].material, atlas, normalMap) : sources[0].material,
      );
      this.hardwareBatches.push(batch);
      this.scene.add(batch);
      batch.name = 'Hardware finish batch / ' + sources[0].material.name;
      batch.sortObjects = false;
      batch.perObjectFrustumCulled = false;
      batch.frustumCulled = false;
      batch.castShadow = false;
      batch.receiveShadow = sources[0].receiveShadow;
      batch.renderOrder = sources[0].renderOrder;
      batch.matrixAutoUpdate = false;
      batch.matrixWorldAutoUpdate = false;
      let ids;
      try {
        ids = new Map();
        for (const geometry of geometries) {
          ids.set(geometry, batch.addGeometry(geometry));
          const pause = checkpoint();
          if (pause) await pause;
        }
      } finally {
        if (atlas) for (const geometry of geometries) geometry.dispose();
      }
      for (const source of sources) {
        const instance = batch.addInstance(ids.get(sourceGeometries.get(source)));
        this.batchBindings.push({
          batch,
          source,
          instance,
          matrix: new THREE.Matrix4(),
          initialized: false,
          visible: null,
        });
        // Keep the original hierarchy as the authoritative pose source. Layer
        // 31 is not rendered; ancestor visibility still hides phone side mounts.
        source.layers.set(31);
      }
      await preparationPause();
    }
    this.updateHardwareBatches();
    // Precompute bounds outside animation. Per-object culling/sorting is off,
    // so only the renderer's opaque sort reads this fixed bounding center.
    for (const batch of this.hardwareBatches) {
      batch.computeBoundingSphere();
      const pause = checkpoint();
      if (pause) await pause;
    }
    this.stats.hardwareBatchInstances = this.batchBindings.length;
    this.stats.hardwareBatchDraws = this.hardwareBatches.length;
    // Three r180 falls back to its per-instance draw loop without this extension.
    this.stats.hardwareBatching = this.renderer.extensions.has('WEBGL_multi_draw')
      ? 'multi-draw'
      : 'draw-loop';
  }
  updateHardwareBatches() {
    for (const binding of this.batchBindings) {
      const { batch, source, instance, matrix } = binding;
      if (!binding.initialized || !matrix.equals(source.matrixWorld)) {
        batch.setMatrixAt(instance, source.matrixWorld);
        matrix.copy(source.matrixWorld);
        binding.initialized = true;
      }
      let visible = true;
      for (let ancestor = source; ancestor; ancestor = ancestor.parent)
        if (!ancestor.visible) {
          visible = false;
          break;
        }
      if (visible !== binding.visible) {
        batch.setVisibleAt(instance, visible);
        binding.visible = visible;
      }
    }
  }
  makeGlass() {
    // Local planar captures obey the same glass planes as the hardware and
    // native HTML. A weak dielectric reflection keeps the manuscript primary.
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.FrontSide,
      uniforms: this.glassUniforms,
      vertexShader: `attribute float reflectionId;attribute vec2 glassUV;
        uniform mat4 reflectionMatrix0;uniform mat4 reflectionMatrix1;uniform mat4 reflectionMatrix2;
        varying vec3 world;varying vec3 surfaceNormal;varying vec4 reflectedPosition;varying float reflectionIndex;varying vec2 paneUV;
        void main(){vec4 p=modelMatrix*vec4(position,1.);world=p.xyz;
        surfaceNormal=normal;reflectionIndex=reflectionId;paneUV=glassUV;
        reflectedPosition=reflectionId<.5?reflectionMatrix0*p:reflectionId<1.5?reflectionMatrix1*p:reflectionMatrix2*p;
        gl_Position=projectionMatrix*viewMatrix*p;}`,
      fragmentShader: `uniform sampler2D reflection0;uniform sampler2D reflection1;uniform sampler2D reflection2;
        varying vec3 world;varying vec3 surfaceNormal;varying vec4 reflectedPosition;varying float reflectionIndex;varying vec2 paneUV;
        void main(){vec3 n=normalize(surfaceNormal),view=normalize(cameraPosition-world);
        vec2 uv=reflectedPosition.xy/reflectedPosition.w;
        vec3 radiance=reflectionIndex<.5?texture2D(reflection0,uv).rgb:reflectionIndex<1.5?texture2D(reflection1,uv).rgb:texture2D(reflection2,uv).rgb;
        float facing=clamp(dot(n,view),0.,1.);
        // A clear coated face and a narrow polished perimeter use the SAME
        // captured cabin radiance. There is no painted stripe or light sweep.
        // The oblique response is art-directed; this is not a coating solver.
        float grazing=pow(1.-facing,3.);
        vec2 edgeDistance=min(paneUV,1.-paneUV);
        float edge=1.-smoothstep(0.,.008,min(edgeDistance.x,edgeDistance.y));
        vec3 reflectance=vec3(.020,.023,.026)+.78*grazing;
        reflectance+=edge*(.09+.09*grazing);
        vec3 light=min(vec3(.13+edge*.025),1.-exp(-radiance*reflectance));
        float alpha=max(max(light.r,light.g),max(light.b,.004));
        gl_FragColor=vec4(light/alpha,alpha);
        #include <colorspace_fragment>
        }`,
    });
  }
  makeMounts() {
    const silver = new THREE.MeshStandardMaterial({
      color: 0x9facb2,
      metalness: 0.95,
      roughness: 0.2,
    });
    const dark = new THREE.MeshStandardMaterial({
      color: 0x142531,
      metalness: 0.7,
      roughness: 0.29,
    });
    this.mounts = [];
    this.mountGroups = {};
    for (const side of [-1, 1]) {
      const group = new THREE.Group();
      this.assembly.add(group);
      this.mountGroups[side] = group;
      for (const y of [0.25, 0.72]) {
        const ring = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 32), silver);
        ring.receiveShadow = true;
        const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.73, 0.73, 1.6, 24), dark);
        axle.receiveShadow = true;
        group.add(ring, axle);
        this.mounts.push({ side, y, ring, axle });
      }
    }
  }
  dims(name) {
    const data = this.metadata.models[name];
    return { width: data.nominalWidth, height: data.nominalHeight, glassQuad: data.contentQuad };
  }
  sideYaw(side, angle) {
    return ((side === 'left' ? 1 : -1) * (16 + angle) * Math.PI) / 180;
  }
  clearanceBounds() {
    // Calibrate the stationary console behind the entire rigid assembly's
    // travel, not only the upright reader. Moving individual mounts to avoid
    // an imaginary horizontal floor breaks the physical hinge attachment.
    const bounds = {
      left: Infinity,
      top: Infinity,
      right: -Infinity,
      bottom: -Infinity,
      depth: 0,
      world: new THREE.Box3(),
    };
    const xAxis = new THREE.Vector3(1, 0, 0),
      yAxis = new THREE.Vector3(0, 1, 0);
    for (const name of this.sideDisplays ? ['center', 'left', 'right'] : ['center']) {
      const entry = this.models[name],
        box = this.metadata.models[name].bounds;
      const folds =
        name === 'center' ? [0] : Array.from({ length: 16 }, (_, i) => Math.min(74, i * 5));
      for (const fold of folds)
        for (let pitch = 0; pitch <= 45; pitch += 5)
          for (const x of [box.min[0], box.max[0]])
            for (const y of [box.min[1], box.max[1]])
              for (const z of [box.min[2], box.max[2]]) {
                const point = new THREE.Vector3(x, y, z)
                  .multiply(entry.size.scale)
                  .add(entry.size.position)
                  .applyAxisAngle(yAxis, name === 'center' ? 0 : this.sideYaw(name, fold))
                  .add(entry.pivot.position)
                  .applyAxisAngle(xAxis, (pitch * Math.PI) / 180)
                  .add(this.assembly.position);
                bounds.depth = Math.max(bounds.depth, -point.z);
                bounds.world.expandByPoint(point);
                point.project(this.camera);
                const px = (point.x * 0.5 + 0.5) * this.width,
                  py = (-point.y * 0.5 + 0.5) * this.height;
                bounds.left = Math.min(bounds.left, px);
                bounds.right = Math.max(bounds.right, px);
                bounds.top = Math.min(bounds.top, py);
                bounds.bottom = Math.max(bounds.bottom, py);
              }
    }
    // Cover subpixel extrema between samples as well as the shell thickness.
    bounds.left -= 2;
    bounds.right += 2;
    bounds.top -= 2;
    bounds.bottom += 2;
    bounds.depth += 2;
    return bounds;
  }
  layout() {
    // A tiny or temporarily hidden viewport can leave a zero-height stage.
    // Keep the last valid camera, receiver and DOM projection until it returns.
    if (!window.ConsoleLayout.snapshot()) {
      this.layoutDirty = true;
      return false;
    }
    window.CockpitEntrance?.beforeLayout();
    const measured = window.ConsoleLayout.snapshot();
    if (!measured) {
      this.layoutDirty = true;
      return false;
    }
    const { reader: r, width: w, height: h, stage, displayStage } = measured;
    const layout = window.ConsoleLayout.measure(r);
    this.sideDisplays = layout.sideDisplays;
    this.hinges.setSideDisplays(this.sideDisplays);
    for (const [side, sign] of [
      ['left', -1],
      ['right', 1],
    ]) {
      this.models[side].pivot.visible = this.sideDisplays;
      this.models[side].light.visible = this.sideDisplays;
      this.mountGroups[sign].visible = this.sideDisplays;
    }
    this.stageRect = displayStage;
    this.width = w;
    this.height = h;
    this.rect = r;
    this.distance = Math.max(3200, w * 4);
    // Pixel-sized world units need a tight depth range. A .1 near plane at this
    // camera distance cannot distinguish the thin glass and machined lip.
    this.camera.near = Math.max(100, this.distance - 1800);
    this.camera.far = this.distance + 2500;
    this.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(h / 2 / this.distance));
    this.camera.aspect = w / h;
    this.camera.position.set(0, 0, this.distance);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    // No hardware or shadow reaches above the upright main screen. Keep a
    // generous bezel margin, and omit that empty strip from GPU presentation.
    // The full camera remains authoritative for HTML and reflected deck rays.
    const raster = window.ConsoleLayout.hardwareRaster(w, h, r, devicePixelRatio);
    this.cropTop = raster.top;
    this.cropHeight = raster.height;
    this.renderCamera.copy(this.camera);
    this.renderCamera.setViewOffset(w, h, 0, this.cropTop, w, this.cropHeight);
    // Thin silver highlights need subpixel detail as the displays turn. Render
    // this cropped layer up to 1.5x, without scaling the rest of the cockpit.
    // Bound the extra pixels on large screens; native HTML stays at device DPR.
    const displayRatio = raster.ratio;
    this.renderer.setPixelRatio(displayRatio);
    this.renderer.setSize(w, this.cropHeight);
    Object.assign(this.renderer.domElement.style, {
      left: '0px',
      top: `${this.cropTop}px`,
      bottom: 'auto',
    });
    // Limit multisample storage as well as the resolution boost. Wide/4K
    // windows must not allocate eight HDR+depth copies of a huge buffer.
    const targetPixels = this.renderer.domElement.width * this.renderer.domElement.height;
    this.settledSamples = Math.max(
      0,
      ...this.supportedSamples.filter((n) => n * targetPixels <= 10000000),
    );
    const entering = ['loading', 'entering'].includes(window.CockpitEntrance?.state);
    const samples = entering
      ? Math.max(0, ...this.supportedSamples.filter((n) => n <= 2))
      : this.settledSamples;
    if (this.hardwareTarget.samples !== samples) {
      this.hardwareTarget.dispose();
      this.hardwareTarget.samples = samples;
    }
    this.hardwareTarget.setSize(this.renderer.domElement.width, this.renderer.domElement.height);
    this.stats.displayPixelRatio = displayRatio;
    this.stats.hardwareSamples = this.hardwareTarget.samples;
    this.assembly.position.set(r.left + r.width / 2 - w / 2, h / 2 - r.bottom, 0);
    const center = this.models.center,
      cd = this.dims('center');
    center.size.scale.set(r.width / cd.width, r.height / cd.height, (r.width / cd.width) * 0.45);
    center.pivot.position.set(0, 0, 0);
    // Keep the entire body inside the windshield, clear of its rim and LEDs,
    // through the complete pitch/yaw range, not merely inside the viewport.
    const solved = window.HybridLayout.solve(measured, this.metadata, this.sideDisplays);
    const scale = solved.scale,
      scaleY = solved.scaleY,
      portrait = solved.portrait,
      hingeX = r.width / 2 + 7,
      mountY = 5;
    this.sideScale = scale;
    for (const side of ['left', 'right']) {
      const sign = side === 'left' ? -1 : 1,
        entry = this.models[side],
        d = this.dims(side);
      entry.size.scale.set(scale, scaleY, scale * 0.45);
      entry.size.position.set(((sign * d.width) / 2) * scale, 0, 0);
      const element = this.sideElements[side],
        responsive = portrait > 0;
      element.screen.toggleAttribute('data-responsive', responsive);
      const contentWidth = (d.glassQuad[1][0] - d.glassQuad[0][0]) * scale;
      const contentHeight = (d.glassQuad[0][1] - d.glassQuad[3][1]) * scaleY;
      element.screen.toggleAttribute('data-brief', responsive && contentWidth < 116);
      this.writeDOM(element.screen, 'style', { width: responsive ? `${contentWidth}px` : '' });
      this.writeDOM(element.screen, 'style', { height: responsive ? `${contentHeight}px` : '' });
      element.width = element.screen.offsetWidth;
      element.height = element.screen.offsetHeight;
      // Both barrels stay bolted to the main housing. Common pitch rotates
      // this entire hierarchy; independent folding changes only side yaw.
      entry.pivot.position.set(sign * hingeX, mountY, 0);
    }
    for (const mount of this.mounts) {
      const sy = this.dims('left').height * scaleY;
      mount.ring.position.set(mount.side * hingeX, sy * mount.y + mountY, 0);
      mount.axle.position.copy(mount.ring.position);
      mount.ring.scale.set(5, Math.max(10, sy * 0.1), 5);
      mount.axle.scale.set(5, Math.max(10, sy * 0.1), 5);
    }
    const deckY = this.assembly.position.y - 7;
    const clearance = this.clearanceBounds();
    const receiver = buildConsoleReceiver(
      this.receiverSource,
      stage,
      r,
      w,
      h,
      this.distance,
      layout,
      clearance,
    );
    this.shadow.geometry.dispose();
    this.receiverDepth.geometry = this.shadow.geometry = receiver;
    this.instrumentRect.value.fromArray(receiver.userData.instrumentRect);
    this.stats.receiverTriangles = receiver.index.count / 3;
    // The ceiling light is on the viewer's side of the displays. Its rays must
    // travel into the desk, not back toward the camera from behind the glass.
    this.key.position.set(-w * 0.16, h * 0.9, Math.max(w, h) * 1.4);
    this.key.target.position.set(0, deckY, 0);
    this.key.updateMatrixWorld(true);
    this.key.target.updateMatrixWorld(true);
    this.key.shadow.updateMatrices(this.key);
    // Only rays through the three casters need depth samples. Fit their entire
    // motion envelope once per layout, not the viewport or each individual pose.
    // 4K then retains fine edges with the same 1K map and no texel-size pumping.
    const lightBounds = new THREE.Box3(),
      box = clearance.world;
    for (const x of [box.min.x, box.max.x])
      for (const y of [box.min.y, box.max.y])
        for (const z of [box.min.z, box.max.z])
          lightBounds.expandByPoint(
            new THREE.Vector3(x, y, z).applyMatrix4(this.key.shadow.camera.matrixWorldInverse),
          );
    Object.assign(this.key.shadow.camera, {
      left: lightBounds.min.x - 16,
      right: lightBounds.max.x + 16,
      top: lightBounds.max.y + 16,
      bottom: lightBounds.min.y - 16,
      near: 1,
      far: Math.max(w, h) * 4 + 1000,
    });
    this.key.shadow.camera.updateProjectionMatrix();
    this.fill.position.set(-w * 0.25, h * 0.25, 600);
    this.fill.lookAt(0, deckY + 200, 0);
    this.warm.position.set(w * 0.5, deckY + 160, 340);
    this.warm.lookAt(0, deckY + 140, 0);
    this.reflections.layout({
      receiver,
      width: w,
      height: h,
      distance: this.distance,
      reader: r,
      stage,
      layout,
      camera: this.camera,
    });
    this.writeDOM(this.reader, 'style', {
      left: '0px',
      top: '0px',
      bottom: 'auto',
      width: `${r.width}px`,
      height: `${r.height}px`,
      transformOrigin: '0 0',
    });
    const glass = cd.glassQuad;
    this.writeDOM(this.main, 'style', {
      inset: 'auto',
      left: `${((glass[0][0] + cd.width / 2) / cd.width) * r.width}px`,
      top: `${((cd.height - glass[0][1]) / cd.height) * r.height}px`,
      width: `${((glass[1][0] - glass[0][0]) / cd.width) * r.width}px`,
      height: `${((glass[0][1] - glass[3][1]) / cd.height) * r.height}px`,
    });
    // Keep the invisible buttons' layout boxes fixed. Their projected grab
    // rectangles change through transforms, rather than relayout during folds.
    for (const { hit } of Object.values(this.sideElements))
      this.writeDOM(hit, 'style', {
        left: '0px',
        top: '0px',
        width: '100px',
        height: '100px',
        padding: '0px',
        transformOrigin: '0 0',
        willChange: 'transform',
      });
    this.layoutDirty = false;
    this.layoutVersion++;
    this.poseKey = '';
    return true;
  }
  points(name, points) {
    const model = this.models[name].size;
    return points.map((p) => {
      const v = new THREE.Vector3(...p).applyMatrix4(model.matrixWorld).project(this.camera);
      return [(v.x * 0.5 + 0.5) * this.width, (-v.y * 0.5 + 0.5) * this.height];
    });
  }
  writeDOM(element, kind, values) {
    if (this.stagedDOM) {
      const writes = this.stagedDOM.get(element) || {};
      Object.assign(writes[kind] || (writes[kind] = {}), values);
      this.stagedDOM.set(element, writes);
      return;
    }
    let state = this.domState.get(element);
    if (!state) {
      state = { style: {}, dataset: {} };
      this.domState.set(element, state);
    }
    const previous = state[kind],
      target = element[kind];
    for (const key in values)
      if (previous[key] !== values[key]) {
        target[key] = values[key];
        previous[key] = values[key];
      }
  }
  publishDOM() {
    const staged = this.stagedDOM;
    this.stagedDOM = null;
    if (staged)
      for (const [element, kinds] of staged)
        for (const [kind, values] of Object.entries(kinds)) this.writeDOM(element, kind, values);
  }
  project(element, points, width, height, origin = { left: 0, top: 0 }) {
    const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = points.map(([x, y]) => [
      x - origin.left,
      y - origin.top,
    ]);
    const dx1 = x1 - x2,
      dx2 = x3 - x2,
      dx3 = x0 - x1 + x2 - x3,
      dy1 = y1 - y2,
      dy2 = y3 - y2,
      dy3 = y0 - y1 + y2 - y3;
    const den = dx1 * dy2 - dx2 * dy1,
      g = Math.abs(den) < 1e-9 ? 0 : (dx3 * dy2 - dx2 * dy3) / den,
      h = Math.abs(den) < 1e-9 ? 0 : (dx1 * dy3 - dx3 * dy1) / den;
    this.writeDOM(element, 'style', {
      transform: `matrix3d(${(x1 - x0 + g * x1) / width},${(y1 - y0 + g * y1) / width},0,${g / width},${(x3 - x0 + h * x3) / height},${(y3 - y0 + h * y3) / height},0,${h / height},0,0,1,0,${x0},${y0},0,1)`,
    });
    this.writeDOM(element, 'dataset', {
      projectedCorners: JSON.stringify(points.map((p) => p.map((n) => +n.toFixed(3)))),
    });
  }
  updatePose() {
    const r = this.rect,
      commonKey = this.layoutVersion + ',' + this.tilt.angle,
      previous = this.worldPose;
    const full = !previous || previous.commonKey !== commonKey;
    const angles = { left: this.hinges.angle('left'), right: this.hinges.angle('right') };
    const changed = {
      center: full,
      left: full || previous.left !== angles.left,
      right: full || previous.right !== angles.right,
    };
    if (full) this.assembly.rotation.x = (this.tilt.angle * Math.PI) / 180;
    for (const side of ['left', 'right']) {
      if (!this.sideDisplays || !changed[side]) continue;
      const entry = this.models[side],
        yaw = this.sideYaw(side, angles[side]);
      entry.pivot.rotation.y = yaw;
      if (!full) entry.pivot.updateMatrixWorld(true);
      this.writeDOM(this.stage, 'dataset', {
        [side + 'HingeLift']: entry.pivot.position.y.toFixed(2),
        [side + 'Yaw']: ((yaw * 180) / Math.PI).toFixed(2),
      });
    }
    // A hinge moves only its own device and shadow silhouette. The mount
    // barrels remain fixed to the common assembly, like the main display.
    // Their parents are unchanged. Only layout or common tilt requires walking
    // the entire scene, including the stationary main and opposite display.
    if (full) this.scene.updateMatrixWorld(true);
    this.updateHardwareBatches();
    this.updateOpticalCovers(changed);
    // A single hinge can move without altering the other screen or main
    // article. Avoid reprojection and DOM invalidation for those fixed planes.
    if (this.projectionKeys.center !== commonKey) {
      const cd = this.dims('center');
      const body = [
        [-cd.width / 2, cd.height, 0],
        [cd.width / 2, cd.height, 0],
        [cd.width / 2, 0, 0],
        [-cd.width / 2, 0, 0],
      ];
      this.project(this.reader, this.points('center', body), r.width, r.height);
      this.writeDOM(this.main, 'dataset', {
        projectedCorners: JSON.stringify(this.points('center', cd.glassQuad)),
      });
      // Cover the visible rear housing thickness too. A convex projected hull
      // stays behind the HTML reader and never grabs empty bounding-box corners.
      const bounds = this.metadata.models.center.bounds,
        box = [];
      for (const x of [bounds.min[0], bounds.max[0]])
        for (const y of [bounds.min[1], bounds.max[1]])
          for (const z of [bounds.min[2], bounds.max[2]]) box.push([x, y, z]);
      const points = this.points('center', box).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      const half = (list) => {
        const hull = [];
        for (const p of list) {
          while (hull.length > 1 && cross(hull.at(-2), hull.at(-1), p) <= 0) hull.pop();
          hull.push(p);
        }
        hull.pop();
        return hull;
      };
      const hull = [...half(points), ...half([...points].reverse())];
      this.writeDOM(this.tilt.housingHit, 'style', {
        clipPath: `polygon(${hull.map(([x, y]) => `${x}px ${y}px`).join(',')})`,
      });
      this.projectionKeys.center = commonKey;
    }
    const stageRect = this.stageRect;
    for (const side of ['left', 'right']) {
      if (!this.sideDisplays) {
        const { screen, hit, grip } = this.sideElements[side];
        for (const element of [screen, hit, grip])
          this.writeDOM(element, 'style', { visibility: 'hidden', pointerEvents: 'none' });
        this.apertures[side === 'left' ? 1 : 2].visible = false;
        continue;
      }
      const d = this.dims(side),
        { screen, hit, grip, width, height } = this.sideElements[side];
      const angle = this.hinges.angle(side),
        fold = this.hinges.foldAmount(side),
        key = commonKey + ',' + angle;
      this.writeDOM(hit, 'dataset', { angle: angle.toFixed(2) });
      this.writeDOM(screen, 'dataset', { angle: angle.toFixed(2) });
      this.writeDOM(this.stage, 'dataset', {
        [side + 'Angle']: angle.toFixed(2),
        [side + 'ManualAngle']: this.hinges.angles[side].toFixed(2),
        [side + 'AutomaticFold']: fold.toFixed(4),
        [side + 'AssemblyScale']: this.sideScale.toFixed(4),
      });
      if (this.projectionKeys[side] === key) continue;
      const quad = this.points(side, d.glassQuad);
      this.project(screen, quad, width, height, stageRect);
      const glassCenter = new THREE.Vector3(0, d.height / 2, 0).applyMatrix4(
        this.models[side].size.matrixWorld,
      );
      const normal = new THREE.Vector3(0, 0, 1).transformDirection(
        this.models[side].size.matrixWorld,
      );
      const facing = normal.dot(this.camera.position.clone().sub(glassCenter).normalize());
      this.writeDOM(screen, 'style', {
        visibility: facing > 0.035 ? 'visible' : 'hidden',
        pointerEvents: '',
      });
      this.apertures[side === 'left' ? 1 : 2].visible = facing > 0.035;
      // Include the rear shell: its narrow edge is the grab surface when closed.
      const bounds = this.metadata.models[side].bounds,
        box = [];
      for (const x of [bounds.min[0], bounds.max[0]])
        for (const y of [bounds.min[1], bounds.max[1]])
          for (const z of [bounds.min[2], bounds.max[2]]) box.push([x, y, z]);
      const corners = this.points(side, box);
      const xs = corners.map((p) => p[0]),
        ys = corners.map((p) => p[1]);
      const mid = (Math.min(...xs) + Math.max(...xs)) / 2,
        half = Math.max(22, (Math.max(...xs) - Math.min(...xs)) / 2 + 9);
      const hitWidth = Math.min(this.width, half * 2),
        left = Math.max(0, Math.min(this.width - hitWidth, mid - half)),
        right = left + hitWidth;
      const top = Math.max(0, Math.min(...ys) - 9),
        bottom = Math.min(this.height, Math.max(...ys) + 9);
      this.writeDOM(hit, 'style', {
        transform: `matrix(${(right - left) / 100},0,0,${(bottom - top) / 100},${left - stageRect.left},${top - stageRect.top})`,
        visibility: 'visible',
        pointerEvents: '',
      });
      this.writeDOM(grip, 'style', { visibility: 'hidden' });
      this.projectionKeys[side] = key;
    }
    let i = 0;
    for (const name of ['center', 'left', 'right']) {
      if (name !== 'center' && !this.sideDisplays) {
        this.spillUniforms.powers.value[i++] = 0;
        continue;
      }
      if (!changed[name]) {
        i++;
        continue;
      }
      const entry = this.models[name],
        d = this.dims(name),
        g = d.glassQuad;
      const center = new THREE.Vector3(0, (g[0][1] + g[3][1]) / 2, 0.065).applyMatrix4(
        entry.size.matrixWorld,
      );
      const normal = new THREE.Vector3(0, 0, 1).transformDirection(entry.size.matrixWorld);
      entry.light.position.copy(center);
      // Only the initial developer finish capture uses area-light orientation.
      // Detached runtime lights retain dimensions/position for spill metadata.
      if (entry.light.parent) entry.light.lookAt(center.clone().add(normal));
      entry.light.width = (g[1][0] - g[0][0]) * entry.size.scale.x;
      entry.light.height = (g[0][1] - g[3][1]) * entry.size.scale.y;
      this.spillUniforms.sources.value[i].copy(center);
      this.spillUniforms.normals.value[i].copy(normal);
      this.spillUniforms.screenAxes.value[i]
        .set(1, 0, 0)
        .transformDirection(entry.size.matrixWorld);
      this.spillUniforms.screenSizes.value[i].set(entry.light.width, entry.light.height);
      this.spillUniforms.powers.value[i] = entry.light.width * entry.light.height * 0.7;
      i++;
    }
    this.worldPose = { commonKey, ...angles };
    this.stats.poseUpdates++;
  }
  render() {
    if (this.disposed || this.contextLost) return false;
    const started = this.diagnostics ? performance.now() : 0;
    if (
      (this.layoutDirty || this.width !== innerWidth || this.height !== innerHeight) &&
      !this.layout()
    )
      return false;
    const entering = ['loading', 'entering'].includes(window.CockpitEntrance?.state);
    const samples = entering
      ? Math.max(0, ...this.supportedSamples.filter((n) => n <= 2))
      : this.settledSamples;
    if (this.hardwareTarget.samples !== samples) {
      this.hardwareTarget.dispose();
      this.hardwareTarget.samples = samples;
      this.poseKey = null;
      this.stats.hardwareSamples = samples;
    }
    const poseKey = [
      this.tilt.angle,
      ...(this.sideDisplays ? [this.hinges.angle('left'), this.hinges.angle('right')] : []),
    ].join(',');
    const poseChanged = poseKey !== this.poseKey;
    if (poseChanged) {
      this.updatePose();
      this.poseKey = poseKey;
      this.reflections.render(this.camera, this.glasses, [
        true,
        this.sideDisplays,
        this.sideDisplays,
      ]);
      this.renderer.shadowMap.autoUpdate = false;
      this.renderer.shadowMap.needsUpdate = true;
      this.renderer.setRenderTarget(this.hardwareTarget);
      this.renderer.clear(true, true, true);
      // Transparent erasers run last in this same scene pass. Resolving MSAA
      // once avoids a second full color/depth copy for only three apertures.
      this.renderCamera.layers.set(0);
      this.renderer.render(this.scene, this.renderCamera);
      if (this.diagnostics) this.stats.hardwareDraws = this.renderer.info.render.calls;
      this.renderer.setRenderTarget(null);
      this.stats.hardwareFrames++;
    }
    // A stationary cabin has no new reflection to capture while space moves.
    if (poseChanged) {
      // The opaque clip-space copy overwrites every color/alpha pixel. Glass
      // overlays need no default-framebuffer depth buffer or preliminary clear.
      this.renderCamera.layers.set(1);
      this.renderer.render(this.opticsScene, this.renderCamera);
      this.renderCamera.layers.set(0);
      this.stats.opticsFrames++;
      if (this.diagnostics) {
        Object.assign(this.stats, {
          opticsDraws: this.renderer.info.render.calls,
          reflectionCaptures: this.reflections.stats.captures,
          shadowMap: this.key.shadow.mapSize.x,
          submissionMs: +(performance.now() - started).toFixed(3),
        });
        this.writeDOM(this.stage, 'dataset', { renderStats: JSON.stringify(this.stats) });
      }
    }
    this.writeDOM(this.stage, 'dataset', {
      displayRenderer: 'physical',
      displayTilt: this.tilt.angle.toFixed(2),
    });
    return true;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.hinges.physical === this) {
      this.hinges.physical = null;
      this.tilt.onChange = null;
    }
    this.host.classList.remove('physical-console');
    this.resizeObserver?.disconnect();
    document.removeEventListener('visibilitychange', this.resumeLayout);
    if (this.loseContext)
      this.renderer.domElement.removeEventListener('webglcontextlost', this.loseContext);
    if (this.restoreContext)
      this.renderer.domElement.removeEventListener('webglcontextrestored', this.restoreContext);
    const geometries = new Set(),
      materials = new Set();
    for (const scene of [this.scene, this.opticsScene])
      scene?.traverse((object) => {
        if (object.isMesh) {
          if (!object.isBatchedMesh) geometries.add(object.geometry);
          for (const material of [].concat(object.material)) materials.add(material);
        }
      });
    for (const batch of this.hardwareBatches) batch.dispose();
    for (const material of this.finishAtlasMaterials || []) materials.add(material);
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of this.deckTextures.values()) {
      texture.dispose();
      texture.image?.close?.();
    }
    for (const texture of this.normalTextures.values()) texture.dispose();
    for (const target of this.matcapTargets) target.dispose();
    for (const texture of this.finishTextures) texture.dispose();
    this.finishAtlas?.dispose();
    this.reflections.dispose();
    this.hardwareTarget?.dispose();
    this.scene.environment?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
window.PhysicalConsole = PhysicalConsole;
