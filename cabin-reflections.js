import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Low-resolution planar mirrors contain only stationary cabin geometry. The
// real display/HTML scene is never captured, and travel does not dirty a map.
export class CabinReflections {
  constructor(renderer, plateTexture) {
    this.renderer = renderer;
    this.generation = 0;
    this.stats = { captures: 0, triangles: 0 };
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x142530);
    this.scene.matrixWorldAutoUpdate = false;
    const type = renderer.extensions.has('EXT_color_buffer_float')
      ? THREE.HalfFloatType
      : THREE.UnsignedByteType;
    this.targets = [384, 192, 192].map(
      (size) =>
        new THREE.WebGLRenderTarget(size, size, {
          type,
          colorSpace: THREE.LinearSRGBColorSpace,
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          generateMipmaps: false,
          depthBuffer: true,
          stencilBuffer: false,
          samples: 0,
        }),
    );
    this.maps = this.targets.map((target) => target.texture);
    this.matrices = [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()];
    this.entries = this.targets.map((target, i) => ({
      target,
      cap: i === 0 ? 384 : 192,
      camera: new THREE.PerspectiveCamera(),
      glassMatrix: new THREE.Matrix4(),
      cameraMatrix: new THREE.Matrix4(),
      projection: new THREE.Matrix4(),
      generation: -1,
    }));
    this.localPlanes = new WeakMap();
    this.uniforms = {
      plate: { value: plateTexture },
      sourceProjection: { value: new THREE.Matrix4() },
      viewport: { value: new THREE.Vector2() },
      stageBox: { value: new THREE.Vector4() },
      instrumentRect: { value: new THREE.Vector4() },
      instrumentVertexStart: { value: Infinity },
      cabinEdges: { value: new THREE.Vector4() },
      cabinOuter: { value: new THREE.Vector2() },
      instrumentScale: { value: new THREE.Vector2() },
    };
    this.consoleMaterial = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      side: THREE.DoubleSide,
      depthWrite: true,
      depthTest: true,
      toneMapped: false,
      vertexShader: `uniform mat4 sourceProjection;uniform float instrumentVertexStart;
        varying vec4 plateProjection;varying float movedInstrument;
        void main(){vec4 world=modelMatrix*vec4(position,1.);
          plateProjection=sourceProjection*world;
          movedInstrument=step(instrumentVertexStart,float(gl_VertexID));
          gl_Position=projectionMatrix*viewMatrix*world;}`,
      fragmentShader: `uniform sampler2D plate;uniform vec2 viewport;uniform vec4 stageBox;uniform vec4 instrumentRect;uniform vec4 cabinEdges;
        uniform vec2 cabinOuter;uniform vec2 instrumentScale;
        varying vec4 plateProjection;varying float movedInstrument;
        vec4 samplePlate(vec2 uv){return texture2D(plate,vec2(uv.x,1.-uv.y));}
        float sourceAt(float p,vec2 edges,vec2 source,vec2 outer){
          if(p<edges.x)return (p-outer.x)*source.x/(edges.x-outer.x);
          if(p<edges.y)return source.x+(p-edges.x)*(source.y-source.x)/(edges.y-edges.x);
          return source.y+(p-edges.y)*(1.-source.y)/(outer.y-edges.y);
        }
        float stripSource(float p){float start=0.;float edge;
          ${window.ConsoleLayout.stripCuts
            .slice(1)
            .map((end, i) => {
              const start = window.ConsoleLayout.stripCuts[i],
                span = end - start;
              return `edge=start+${span}.*instrumentScale.${i % 2 ? 'y' : 'x'};if(p<=edge)return (${start}.+(p-start)/max(.000001,edge-start)*${span}.)/618.;start=edge;`;
            })
            .join('\n')}
          return 1.;
        }
        void main(){
          vec2 pixel=(plateProjection.xy/plateProjection.w*vec2(.5,-.5)+.5)*viewport;
          vec2 uv=(pixel-stageBox.xy)/stageBox.zw;
          vec3 metal=vec3(.09,.13,.16);
          if(movedInstrument>.5){
            vec2 p=clamp((uv-instrumentRect.xy)/instrumentRect.zw,0.,1.);
            p.x=stripSource(p.x);
            uv=(vec2(491.,775.)+p*vec2(618.,60.))/vec2(1600.,1000.);
          }else{
            uv=vec2(sourceAt(uv.x,cabinEdges.xy,vec2(.3,.7),cabinOuter),sourceAt(uv.y,cabinEdges.zw,vec2(.11,.175),vec2(0.,1.)));
          }
          if(all(greaterThanEqual(uv,vec2(0.)))&&all(lessThanEqual(uv,vec2(1.)))){
            vec4 color=samplePlate(uv);metal=mix(metal,color.rgb,color.a);
            if(movedInstrument<.5){
              // Match the deck repair underneath the relocated instrument.
              vec2 p=(uv*vec2(1600.,1000.)-vec2(416.,720.))/vec2(768.,148.);
              if(all(greaterThanEqual(p,vec2(0.)))&&all(lessThanEqual(p,vec2(1.)))){
                float across=min(clamp(p.x/.035,0.,1.),clamp((1.-p.x)/.035,0.,1.));
                float down=clamp((1.-p.y)/.2,0.,1.);
                vec4 patchedColor=samplePlate((vec2(185.,739.)+p*vec2(213.,40.))/vec2(1600.,1000.));
                metal=mix(metal,patchedColor.rgb,across*down*patchedColor.a);
              }
            }
          }
          gl_FragColor=vec4(metal,1.);
        }`,
    });
    this.emptyGeometry = new THREE.BufferGeometry();
    this.consoleMesh = new THREE.Mesh(this.emptyGeometry, this.consoleMaterial);
    this.consoleMesh.frustumCulled = false;
    this.scene.add(this.consoleMesh);
    this.cabinMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.cabinMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.cabinMaterial);
    this.scene.add(this.cabinMesh);
    this.scratch = {
      point: new THREE.Vector3(),
      normal: new THREE.Vector3(),
      eye: new THREE.Vector3(),
      view: new THREE.Vector3(),
      look: new THREE.Vector3(),
      target: new THREE.Vector3(),
      rotation: new THREE.Matrix4(),
      normalMatrix: new THREE.Matrix3(),
      plane: new THREE.Plane(),
      clip: new THREE.Vector4(),
      q: new THREE.Vector4(),
      corner: new THREE.Vector3(),
    };
  }
  layout({ receiver, width, height, distance, reader, stage, layout, camera }) {
    this.width = width;
    this.height = height;
    this.distance = distance;
    // Borrow exactly the geometry that receives the moving monitor shadows.
    // The display owner replaces/disposes it; this helper never does either.
    this.consoleMesh.geometry = receiver;
    this.uniforms.sourceProjection.value.multiplyMatrices(
      camera.projectionMatrix,
      camera.matrixWorldInverse,
    );
    this.uniforms.viewport.value.set(width, height);
    this.uniforms.stageBox.value.set(stage.left, stage.top, stage.width, stage.height);
    const cabin = window.ConsoleLayout.cabin(stage);
    this.uniforms.cabinEdges.value.set(
      cabin.x[1] / stage.width,
      cabin.x[2] / stage.width,
      cabin.y[1] / stage.height,
      cabin.y[2] / stage.height,
    );
    this.uniforms.cabinOuter.value.set(cabin.x[0] / stage.width, cabin.x[3] / stage.width);
    const panel = layout.instrument,
      panelWidth = Math.max(1, panel.width),
      fixed = panel.height / 60;
    this.uniforms.instrumentScale.value.set(
      fixed / panelWidth,
      Math.max(0, (panelWidth - 424 * fixed) / 194) / panelWidth,
    );
    this.uniforms.instrumentRect.value.fromArray(receiver.userData.instrumentRect);
    this.uniforms.instrumentVertexStart.value =
      receiver.userData.instrumentVertexStart ?? receiver.attributes.position.count;
    this.buildCabin(width, height, distance, reader);
    this.scene.updateMatrixWorld(true);
    this.stats.triangles =
      (receiver.index?.count ?? receiver.attributes.position.count) / 3 +
      this.cabinMesh.geometry.index.count / 3;
    this.invalidate();
  }
  buildCabin(width, height, distance, reader) {
    const pieces = [];
    const dark = new THREE.Color(0x263943),
      recess = new THREE.Color(0x202f39),
      ceiling = new THREE.Color(0x354953);
    const box = (x, y, z, w, h, d, color) => {
      const geometry = new THREE.BoxGeometry(w, h, d);
      geometry.translate(x, y, z);
      const colors = new Float32Array(geometry.attributes.position.count * 3);
      for (let i = 0; i < colors.length; i += 3) {
        colors[i] = color.r;
        colors[i + 1] = color.g;
        colors[i + 2] = color.b;
      }
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      pieces.push(geometry);
    };
    const half = Math.max(width * 0.7, reader.width * 1.65, 560),
      floor = height / 2 - reader.bottom - Math.max(160, reader.height * 0.55),
      top = Math.max(height * 0.55, height / 2 - reader.top + 220),
      front = -Math.max(700, reader.width * 1.25),
      back = distance + Math.max(650, reader.width * 1.2),
      roomHeight = top - floor,
      depth = back - front;
    this.captureFar = Math.max(distance * 3 + depth, 10000);
    // Broad structural surfaces extend alongside the eye, not just behind it.
    box(0, (top + floor) / 2, back, half * 2, roomHeight, 40, dark);
    box(-half, (top + floor) / 2, (front + back) / 2, 36, roomHeight, depth, dark);
    box(half, (top + floor) / 2, (front + back) / 2, 36, roomHeight, depth, dark);
    box(0, top, (front + back) / 2, half * 2, 35, depth, ceiling);
    box(0, floor, (front + back) / 2, half * 2, 35, depth, recess);
    // One broad, diffused cabin light replaces sharp rails and panel seams.
    // Its edges fade into the wall color, so the glass reads as a continuous
    // surface rather than a set of bright vertical scratches. It remains real
    // reflection geometry: the highlight moves with the mirrored camera.
    const glow = new THREE.PlaneGeometry(half * 1.7, roomHeight * 0.68, 24, 12);
    const colors = new Float32Array(glow.attributes.position.count * 3),
      uv = glow.attributes.uv;
    const light = new THREE.Color().setRGB(0.5, 0.58, 0.62),
      color = new THREE.Color();
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i) * 2 - 1,
        v = uv.getY(i) * 2 - 1;
      const weight = Math.pow(Math.max(0, 1 - u * u), 2) * Math.pow(Math.max(0, 1 - v * v), 2);
      color.copy(dark).lerp(light, weight);
      color.toArray(colors, i * 3);
    }
    glow.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    glow.translate(-half * 0.16, floor + roomHeight * 0.7, back - 24);
    pieces.push(glow);
    // A broad pool of bounced cabin light on the recessed floor becomes visible
    // as the screen closes toward the viewer. It blends into the floor material
    // rather than introducing a reflected fixture, seam or animated stripe.
    const diffuser = new THREE.PlaneGeometry(half * 1.6, depth * 0.72, 16, 12);
    const diffuserUV = diffuser.attributes.uv,
      diffuserColors = new Float32Array(diffuserUV.count * 3);
    const diffuserLight = new THREE.Color().setRGB(1.0, 1.1, 1.14);
    for (let i = 0; i < diffuserUV.count; i++) {
      const u = diffuserUV.getX(i) * 2 - 1,
        v = diffuserUV.getY(i) * 2 - 1;
      const weight = Math.pow(Math.max(0, 1 - u * u), 3) * Math.pow(Math.max(0, 1 - v * v), 3);
      color.copy(recess).lerp(diffuserLight, weight);
      color.toArray(diffuserColors, i * 3);
    }
    diffuser.setAttribute('color', new THREE.BufferAttribute(diffuserColors, 3));
    diffuser.rotateX(-Math.PI / 2);
    diffuser.translate(-half * 0.12, floor + 19, distance * 0.12);
    pieces.push(diffuser);
    const geometry = mergeGeometries(pieces, false);
    for (const piece of pieces) piece.dispose();
    this.cabinMesh.geometry.dispose();
    this.cabinMesh.geometry = geometry;
  }
  localPlane(geometry) {
    let plane = this.localPlanes.get(geometry);
    if (plane) return plane;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    const positions = geometry.attributes.position,
      normals = geometry.attributes.normal,
      index = geometry.index;
    const a = new THREE.Vector3(),
      b = new THREE.Vector3(),
      c = new THREE.Vector3(),
      cross = new THREE.Vector3(),
      edge = new THREE.Vector3();
    let largest = -1,
      normal = new THREE.Vector3(0, 0, 1),
      point = geometry.boundingBox.getCenter(new THREE.Vector3());
    const count = index?.count ?? positions.count;
    // Select the broad glass face rather than a tiny edge/bevel normal.
    for (let i = 0; i + 2 < count; i += 3) {
      const ia = index ? index.getX(i) : i,
        ib = index ? index.getX(i + 1) : i + 1,
        ic = index ? index.getX(i + 2) : i + 2;
      a.fromBufferAttribute(positions, ia);
      b.fromBufferAttribute(positions, ib);
      c.fromBufferAttribute(positions, ic);
      cross.subVectors(b, a).cross(edge.subVectors(c, a));
      const area = cross.lengthSq();
      if (area <= largest) continue;
      largest = area;
      normal.copy(cross).normalize();
      point
        .copy(a)
        .add(b)
        .add(c)
        .multiplyScalar(1 / 3);
      if (normals && normal.dot(edge.fromBufferAttribute(normals, ia)) < 0) normal.negate();
    }
    plane = { point, normal };
    this.localPlanes.set(geometry, plane);
    return plane;
  }
  prepareCamera(entry, camera, glass, matrix) {
    const s = this.scratch,
      local = this.localPlane(glass.geometry),
      virtual = entry.camera;
    s.point.copy(local.point).applyMatrix4(glass.matrixWorld);
    s.normal
      .copy(local.normal)
      .applyMatrix3(s.normalMatrix.getNormalMatrix(glass.matrixWorld))
      .normalize();
    s.eye.setFromMatrixPosition(camera.matrixWorld);
    s.view.subVectors(s.point, s.eye);
    if (s.view.dot(s.normal) >= -0.001) return false;
    s.view.reflect(s.normal).negate().add(s.point);
    s.rotation.extractRotation(camera.matrixWorld);
    s.look.set(0, 0, -1).applyMatrix4(s.rotation).add(s.eye);
    s.target.subVectors(s.point, s.look).reflect(s.normal).negate().add(s.point);
    virtual.copy(camera, false);
    virtual.position.copy(s.view);
    virtual.up.set(0, 1, 0).applyMatrix4(s.rotation).reflect(s.normal);
    virtual.lookAt(s.target);
    virtual.far = Math.max(camera.far, this.captureFar);
    virtual.clearViewOffset();
    virtual.updateProjectionMatrix();
    virtual.updateMatrixWorld(true);
    // Crop in the reflected view. Its screen-space handedness differs from
    // the real camera, especially for an asymmetric folded side display.
    const bounds = glass.geometry.boundingBox;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const x of [bounds.min.x, bounds.max.x])
      for (const y of [bounds.min.y, bounds.max.y])
        for (const z of [bounds.min.z, bounds.max.z]) {
          s.corner.set(x, y, z).applyMatrix4(glass.matrixWorld).project(virtual);
          minX = Math.min(minX, s.corner.x);
          minY = Math.min(minY, s.corner.y);
          maxX = Math.max(maxX, s.corner.x);
          maxY = Math.max(maxY, s.corner.y);
        }
    const padX = 4 / this.width,
      padY = 4 / this.height;
    minX -= padX;
    maxX += padX;
    minY -= padY;
    maxY += padY;
    const cropWidth = ((maxX - minX) * this.width) / 2,
      cropHeight = ((maxY - minY) * this.height) / 2;
    if (!Number.isFinite(cropWidth + cropHeight) || cropWidth <= 0 || cropHeight <= 0) return false;
    virtual.setViewOffset(
      this.width,
      this.height,
      ((minX + 1) * this.width) / 2,
      ((1 - maxY) * this.height) / 2,
      cropWidth,
      cropHeight,
    );
    // Keep storage fixed during motion. The projective texture matrix handles
    // a non-square crop without reallocating color/depth targets at every pose.
    matrix
      .set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(virtual.projectionMatrix)
      .multiply(virtual.matrixWorldInverse);
    // The standard Reflector oblique near plane removes every object behind
    // the reflective surface; the depth buffer resolves all nearer surfaces.
    s.plane
      .setFromNormalAndCoplanarPoint(s.normal, s.point)
      .applyMatrix4(virtual.matrixWorldInverse);
    s.clip.set(s.plane.normal.x, s.plane.normal.y, s.plane.normal.z, s.plane.constant);
    const p = virtual.projectionMatrix.elements;
    s.q.set(
      (Math.sign(s.clip.x) + p[8]) / p[0],
      (Math.sign(s.clip.y) + p[9]) / p[5],
      -1,
      (1 + p[10]) / p[14],
    );
    const denominator = s.clip.dot(s.q);
    if (Math.abs(denominator) < 1e-8) return false;
    s.clip.multiplyScalar(2 / denominator);
    p[2] = s.clip.x;
    p[6] = s.clip.y;
    p[10] = s.clip.z + 1 - 0.0001;
    p[14] = s.clip.w;
    virtual.projectionMatrixInverse.copy(virtual.projectionMatrix).invert();
    return true;
  }
  render(camera, glasses, visible = [true, true, true], changed) {
    const dirty = [];
    for (let i = 0; i < 3; i++) {
      const glass = glasses[i],
        entry = this.entries[i];
      if (!visible[i] || !glass) continue;
      const hint = changed?.[i] ?? changed?.[['center', 'left', 'right'][i]];
      if (
        hint ||
        entry.generation !== this.generation ||
        !entry.glassMatrix.equals(glass.matrixWorld) ||
        !entry.cameraMatrix.equals(camera.matrixWorld) ||
        !entry.projection.equals(camera.projectionMatrix)
      ) {
        if (this.prepareCamera(entry, camera, glass, this.matrices[i])) dirty.push([i, glass]);
      }
    }
    if (!dirty.length) return;
    const r = this.renderer;
    const previous = {
      target: r.getRenderTarget(),
      face: r.getActiveCubeFace(),
      level: r.getActiveMipmapLevel(),
      viewport: r.getViewport(new THREE.Vector4()),
      scissor: r.getScissor(new THREE.Vector4()),
      scissorTest: r.getScissorTest(),
      color: r.getClearColor(new THREE.Color()),
      alpha: r.getClearAlpha(),
      autoClear: r.autoClear,
      xr: r.xr.enabled,
      shadowEnabled: r.shadowMap.enabled,
      shadowAuto: r.shadowMap.autoUpdate,
      shadowNeeds: r.shadowMap.needsUpdate,
    };
    try {
      r.xr.enabled = false;
      r.shadowMap.enabled = false;
      r.shadowMap.autoUpdate = false;
      r.autoClear = false;
      r.setClearColor(this.scene.background, 1);
      for (const [i, glass] of dirty) {
        const entry = this.entries[i];
        r.setRenderTarget(entry.target);
        // setRenderTarget already selects its pixel viewport. setViewport here
        // would apply the display DPR again and crop the reflection incorrectly.
        r.setScissorTest(false);
        r.state.buffers.depth.setMask(true);
        r.clear(true, true, false);
        r.render(this.scene, entry.camera);
        entry.glassMatrix.copy(glass.matrixWorld);
        entry.cameraMatrix.copy(camera.matrixWorld);
        entry.projection.copy(camera.projectionMatrix);
        entry.generation = this.generation;
        this.stats.captures++;
      }
    } finally {
      r.xr.enabled = previous.xr;
      r.shadowMap.enabled = previous.shadowEnabled;
      r.shadowMap.autoUpdate = previous.shadowAuto;
      r.shadowMap.needsUpdate = previous.shadowNeeds;
      r.autoClear = previous.autoClear;
      r.setRenderTarget(previous.target, previous.face, previous.level);
      if (!previous.target) {
        r.setViewport(previous.viewport);
        r.setScissor(previous.scissor);
      }
      r.setScissorTest(previous.scissorTest);
      r.setClearColor(previous.color, previous.alpha);
      // Three tracks depth writes and sets them for each following material.
      // Reading DEPTH_WRITEMASK here stalls the CPU behind the GPU every time
      // the head or a display moves; no raw GL code needs that snapshot.
    }
  }
  invalidate() {
    this.generation++;
  }
  dispose() {
    for (const target of this.targets) target.dispose();
    this.cabinMesh.geometry.dispose();
    this.emptyGeometry.dispose();
    this.consoleMaterial.dispose();
    this.cabinMaterial.dispose();
    this.scene.clear();
  }
}
