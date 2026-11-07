import { buildConsoleReceiverData } from './console-receiver-data.js';
import { settleGpu } from './gpu-settle.mjs';
import { receiverAttributes } from './receiver-attributes.mjs';
// Only the stationary desk lighting is drawn here. Models, text and controls
// still wait for the full renderer. This pass has no animation loop.
window.HybridDeskShadow = class {
  static async create() {
    const result = new window.HybridDeskShadow();
    try {
      const gl = result.gl,
        parallel = gl.getExtension('KHR_parallel_shader_compile');
      const started = performance.now();
      if (parallel) {
        while (!gl.getProgramParameter(result.program, parallel.COMPLETION_STATUS_KHR)) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (gl.isContextLost() || performance.now() - started > 10000) {
            throw Error('Initial desk shader unavailable');
          }
        }
      }
      if (!gl.getProgramParameter(result.program, gl.LINK_STATUS)) {
        throw Error(gl.getProgramInfoLog(result.program));
      }
      return result;
    } catch (error) {
      result.dispose();
      throw error;
    }
  }
  constructor() {
    this.canvas = document.createElement('canvas');
    const attributes = {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
    };
    const gl = (this.gl =
      this.canvas.getContext('webgl2', attributes) || this.canvas.getContext('webgl', attributes));
    if (!gl) throw Error('Initial desk context unavailable');
    const shader = (type, source) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, source);
      gl.compileShader(s);
      // Check completion after linking, so supported browsers compile while
      // the artwork downloads instead of synchronously blocking here.
      return s;
    };
    const p = (this.program = gl.createProgram());
    gl.attachShader(
      p,
      shader(
        gl.VERTEX_SHADER,
        `precision highp float;
   attribute vec3 position,normal;attribute vec2 plateUv;attribute float strength;
   uniform vec4 viewport;uniform vec2 crop;uniform float distance;
   varying vec3 vWorld,vNormal;varying vec2 vUv;varying float vStrength;
   void main(){float z=distance-position.z;float px=position.x*distance/z+viewport.x*.5;
    float py=viewport.y*.5-position.y*distance/z;
    gl_Position=vec4((px/viewport.x*2.-1.)*z,(1.-(py-crop.x)/crop.y*2.)*z,((z-(distance-1800.))/4300.*2.-1.)*z,z);
    vWorld=position;vNormal=normal;vUv=plateUv;vStrength=strength;}`,
      ),
    );
    gl.attachShader(
      p,
      shader(
        gl.FRAGMENT_SHADER,
        `precision highp float;
   uniform sampler2D plate;uniform vec4 edges,panel;uniform vec2 outer;
   uniform vec3 light,eye,origins[3],scales[3],boxMin[3],boxMax[3],sources[3],normals[3],axes[3];
   uniform vec2 yaws[3],sizes[3];uniform float powers[3],enabled[3];
   varying vec3 vWorld,vNormal;varying vec2 vUv;varying float vStrength;
   float coord(float p,vec2 e,vec2 s,vec2 o){if(p<e.x)return(p-o.x)*s.x/(e.x-o.x);if(p<e.y)return s.x+(p-e.x)*(s.y-s.x)/(e.y-e.x);return s.y+(p-e.y)*(1.-s.y)/(o.y-e.y);}
   vec3 undo(vec3 p,vec2 a){return vec3(a.x*p.x-a.y*p.z,p.y,a.y*p.x+a.x*p.z);}
   float blocked(vec3 world,vec3 direction){float result=0.;for(int i=0;i<3;i++){
    vec3 p=undo(world-origins[i],yaws[i])/scales[i],d=undo(direction,yaws[i])/scales[i];
    d=sign(d+vec3(.0000001))*max(abs(d),vec3(.0000001));
    vec3 a=(boxMin[i]-p)/d,b=(boxMax[i]-p)/d,lo=min(a,b),hi=max(a,b);
    float near=max(lo.x,max(lo.y,lo.z)),far=min(hi.x,min(hi.y,hi.z));
    result=max(result,enabled[i]*step(max(near,0.),far));}return result;}
   vec3 srgb(vec3 x){return mix(x*12.92,1.055*pow(max(x,0.),vec3(1./2.4))-.055,step(vec3(.0031308),x));}
   vec3 aces(vec3 c){c=mat3(.59719,.076,.0284,.35458,.90834,.13383,.04823,.01566,.83777)*(c*2.);
    c=(c*(c+.0245786)-.000090537)/(c*(.983729*c+.4329510)+.238081);
    return clamp(mat3(1.60475,-.10208,-.00327,-.53108,1.10813,-.07276,-.07367,-.00605,1.07602)*c,0.,1.);}
   void main(){vec3 n=normalize(vNormal)*(gl_FrontFacing?1.:-1.);
    vec3 axis=normalize(cross(light,vec3(0.,1.,0.))),axisY=cross(light,axis);
    vec3 world=vWorld+n*.3;float occlusion=0.;
    for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++)occlusion+=blocked(world+axis*float(x)*.65+axisY*float(y)*.65,light)/9.;
    vec2 q=(vUv-panel.xy)/panel.zw;
    float emission=step(.035,q.x)*step(q.x,.965)*step(.17,q.y)*step(q.y,.81);
    vec2 uv=vec2(coord(vUv.x,edges.xy,vec2(.3,.7),outer),coord(vUv.y,edges.zw,vec2(.11,.175),vec2(0.,1.)));
    vec3 radiance=pow(texture2D(plate,uv).rgb,vec3(2.2));
    if(vStrength<.99)emission=max(emission,smoothstep(.08,.6,max(radiance.r,max(radiance.g,radiance.b))));
    emission=max(emission,smoothstep(.035,.3,radiance.r-radiance.b*1.25)*step(.838,uv.y));
    float shadow=.45*occlusion*vStrength*(1.-emission*.96);
    float energy=0.,reflection=0.;vec3 view=normalize(eye-vWorld),reflected=reflect(-view,n);
    for(int i=0;i<3;i++){vec3 ray=vWorld-sources[i];float d2=max(dot(ray,ray),1600.);vec3 direction=normalize(ray);
     energy+=powers[i]*max(dot(direction,normals[i]),0.)*max(dot(-direction,n),0.)/d2;
     float facing=dot(reflected,normals[i]);if(powers[i]>0.&&facing<-.001){float travel=dot(sources[i]-vWorld,normals[i])/facing;
      vec3 hit=vWorld+reflected*travel-sources[i],vertical=cross(normals[i],axes[i]);
      vec2 offset=abs(vec2(dot(hit,axes[i]),dot(hit,vertical)))-sizes[i]*.5;
      float blur=max(12.,abs(travel)*.14);vec2 coverage=1.-smoothstep(vec2(-blur),vec2(blur),offset);
      reflection+=coverage.x*coverage.y*step(0.,travel)*(.025+.075*pow(1.-max(dot(n,view),0.),3.));}}
    float spill=(.10*(1.-exp(-energy*2.))+reflection)*vStrength*(1.-emission*.9);
    float alpha=min(1.,shadow+spill);
    vec3 color=(vec3(.0003035,.0021247,.0056054)*shadow+vec3(.16,.67,1.)*spill)/max(alpha,.00001);
    gl_FragColor=vec4(srgb(aces(color))*alpha,alpha);
   }`,
      ),
    );
    gl.linkProgram(p);
    this.texture = gl.createTexture();
    this.buffers = {};
  }
  async preparePlate(plate) {
    if (this.plate === plate || typeof createImageBitmap !== 'function') return;
    let bitmap;
    try {
      bitmap = await createImageBitmap(plate, { premultiplyAlpha: 'none' });
      if (this.disposed) return;
      this.plateBitmap?.close();
      this.plateBitmap = bitmap;
      this.plate = plate;
      bitmap = null;
    } catch {
      // Older decoders retain the identical HTML-image upload path.
    } finally {
      bitmap?.close();
    }
  }
  render(source, plate, measured, layout, art) {
    const { width: w, height: h, reader: r, stage } = measured,
      side = window.ConsoleLayout.measure(r).sideDisplays;
    const clearance = {
      left: Infinity,
      top: Infinity,
      right: -Infinity,
      bottom: -Infinity,
      depth: 0,
    };
    for (const name of side ? ['center', 'left', 'right'] : ['center']) {
      const b = art.models[name].bounds;
      for (const fold of name === 'center'
        ? [0]
        : Array.from({ length: 16 }, (_, i) => Math.min(74, i * 5)))
        for (let pitch = 0; pitch <= 45; pitch += 5)
          for (const x of [b.min[0], b.max[0]])
            for (const y of [b.min[1], b.max[1]])
              for (const z of [b.min[2], b.max[2]]) {
                const q = layout.world(
                    name,
                    [x, y, z],
                    layout.scale,
                    fold,
                    (pitch * Math.PI) / 180,
                  ),
                  p = layout.project(q);
                clearance.depth = Math.max(clearance.depth, -q[2]);
                clearance.left = Math.min(clearance.left, p[0]);
                clearance.right = Math.max(clearance.right, p[0]);
                clearance.top = Math.min(clearance.top, p[1]);
                clearance.bottom = Math.max(clearance.bottom, p[1]);
              }
    }
    clearance.left -= 2;
    clearance.right += 2;
    clearance.top -= 2;
    clearance.bottom += 2;
    clearance.depth += 2;
    const data = buildConsoleReceiverData(
        source,
        stage,
        r,
        w,
        h,
        layout.distance,
        window.ConsoleLayout.measure(r),
        clearance,
      ),
      attributes = receiverAttributes(data);
    const gl = this.gl,
      p = this.program,
      raster = window.ConsoleLayout.hardwareRaster(w, h, r, devicePixelRatio);
    this.canvas.width = raster.width;
    this.canvas.height = raster.pixelsHeight;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(p);
    const attr = (name, size) => {
      const b = (this.buffers[name] ||= gl.createBuffer());
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, attributes[name], gl.STATIC_DRAW);
      const a = gl.getAttribLocation(p, name);
      gl.enableVertexAttribArray(a);
      gl.vertexAttribPointer(a, size, gl.FLOAT, false, 0, 0);
    };
    attr('position', 3);
    attr('normal', 3);
    attr('plateUv', 2);
    attr('strength', 1);
    const uniform = (name, size, value) =>
      gl['uniform' + size + 'fv'](gl.getUniformLocation(p, name), value);
    uniform('viewport', 4, [w, h, 0, 0]);
    uniform('crop', 2, [raster.top, raster.height]);
    gl.uniform1f(gl.getUniformLocation(p, 'distance'), layout.distance);
    uniform('eye', 3, [0, 0, layout.distance]);
    const key = [-w * 0.16, h * 0.9 - (layout.assembly[1] - 7), Math.max(w, h) * 1.4],
      length = Math.hypot(...key);
    uniform(
      'light',
      3,
      key.map((v) => v / length),
    );
    const cabin = window.ConsoleLayout.cabin(stage);
    uniform('edges', 4, [
      cabin.x[1] / stage.width,
      cabin.x[2] / stage.width,
      cabin.y[1] / stage.height,
      cabin.y[2] / stage.height,
    ]);
    uniform('outer', 2, [cabin.x[0] / stage.width, cabin.x[3] / stage.width]);
    uniform('panel', 4, data.instrumentRect);
    const all = {
      origins: [],
      scales: [],
      boxMin: [],
      boxMax: [],
      yaws: [],
      sources: [],
      normals: [],
      axes: [],
      sizes: [],
      powers: [],
      enabled: [],
    };
    for (const name of ['center', 'left', 'right']) {
      const m = art.models[name],
        sign = name === 'left' ? -1 : 1,
        angle = name === 'center' ? 0 : (-sign * (16 + layout.folds[name]) * Math.PI) / 180,
        c = Math.cos(angle),
        s = Math.sin(angle),
        scale =
          name === 'center'
            ? [
                r.width / m.nominalWidth,
                r.height / m.nominalHeight,
                (r.width / m.nominalWidth) * 0.45,
              ]
            : [layout.scale, layout.scaleY, layout.scale * 0.45],
        g = m.contentQuad;
      all.origins.push(
        ...layout.world(name, [0, 0, 0], layout.scale, name === 'center' ? 0 : layout.folds[name]),
      );
      all.scales.push(...scale);
      all.yaws.push(c, s);
      all.boxMin.push(-m.nominalWidth / 2, 0, m.bounds.min[2]);
      all.boxMax.push(m.nominalWidth / 2, m.nominalHeight, m.bounds.max[2]);
      all.sources.push(
        ...layout.world(
          name,
          [0, (g[0][1] + g[3][1]) / 2, 0.065],
          layout.scale,
          name === 'center' ? 0 : layout.folds[name],
        ),
      );
      all.normals.push(s, 0, c);
      all.axes.push(c, 0, -s);
      const width = (g[1][0] - g[0][0]) * scale[0],
        height = (g[0][1] - g[3][1]) * scale[1];
      all.sizes.push(width, height);
      all.powers.push(name === 'center' || side ? width * height * 0.7 : 0);
      all.enabled.push(name === 'center' || side ? 1 : 0);
    }
    for (const [name, values] of Object.entries(all))
      uniform(
        name + '[0]',
        ['yaws', 'sizes'].includes(name) ? 2 : ['powers', 'enabled'].includes(name) ? 1 : 3,
        values,
      );
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    // Resizing changes receiver geometry, not the immutable cabin pixels.
    if (this.uploadedPlate !== plate) {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        this.plate === plate ? this.plateBitmap : plate,
      );
      this.uploadedPlate = plate;
    }
    gl.uniform1i(gl.getUniformLocation(p, 'plate'), 0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.colorMask(false, false, false, false);
    gl.drawArrays(gl.TRIANGLES, 0, data.indices.length);
    gl.colorMask(true, true, true, true);
    gl.depthMask(false);
    gl.drawArrays(gl.TRIANGLES, 0, data.indices.length);
    gl.depthMask(true);
    return this.canvas;
  }
  settled() {
    return settleGpu(this.gl);
  }
  dispose() {
    this.disposed = true;
    this.plateBitmap?.close();
    const gl = this.gl;
    this.canvas.remove();
    for (const b of Object.values(this.buffers)) gl.deleteBuffer(b);
    gl.deleteTexture(this.texture);
    gl.deleteProgram(this.program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
};
