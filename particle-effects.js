'use strict';

// One retained GPU surface for the photographs and reversible particle lights.
// Textures and geometry are immutable; travel only changes small uniforms.
window.JourneyParticles = class {
  constructor(reference, onUnavailable, photos) {
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('aria-hidden', 'true');
    Object.assign(this.canvas.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      mixBlendMode: 'normal',
      opacity: '1',
      zIndex: '5',
    });
    const gl = this.canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power',
    });
    if (!gl) throw new Error('Particle WebGL is unavailable');
    this.gl = gl;
    // Read immutable capabilities before submitting uploads. A capability query
    // after them can synchronously wait for unrelated work already on the GPU.
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const resources = (this.resources = {
      shaders: [],
      programs: [],
      buffers: [],
      textures: [],
      vaos: [],
    });
    this.vao = gl.getExtension('OES_vertex_array_object');
    try {
      const shader = (type, source) => {
        const s = gl.createShader(type);
        resources.shaders.push(s);
        gl.shaderSource(s, source);
        gl.compileShader(s);
        return s;
      };
      this.shader = shader;
      this.particleAttributes = [];
      // Photo uploads must retain the original premultiplied alpha even when
      // the flight program has not been requested yet.
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      const photoVertex = shader(
        gl.VERTEX_SHADER,
        `
   precision highp float;attribute vec2 aCorner;uniform vec4 uRect;uniform vec2 uViewport;uniform vec3 uProjection;varying highp vec2 vUV;
   void main(){vUV=aCorner;vec2 pixel=(uRect.xy+aCorner*uRect.zw)*uProjection.x+uProjection.yz;gl_Position=vec4(pixel.x/uViewport.x*2.-1.,1.-pixel.y/uViewport.y*2.,0.,1.);}`,
      );
      const photoFragment = shader(
        gl.FRAGMENT_SHADER,
        `
   precision highp float;uniform sampler2D uPhoto;uniform float uAlpha;varying highp vec2 vUV;
   void main(){gl_FragColor=texture2D(uPhoto,vUV)*uAlpha;}`,
      );
      this.photoProgram = gl.createProgram();
      resources.programs.push(this.photoProgram);
      gl.attachShader(this.photoProgram, photoVertex);
      gl.attachShader(this.photoProgram, photoFragment);
      gl.linkProgram(this.photoProgram);
      if (!gl.getProgramParameter(this.photoProgram, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(this.photoProgram));
      gl.deleteShader(photoVertex);
      gl.deleteShader(photoFragment);
      resources.shaders.length = 0;
      gl.useProgram(this.photoProgram);
      this.photoUniforms = Object.fromEntries(
        ['uRect', 'uViewport', 'uProjection', 'uAlpha'].map((name) => [
          name,
          gl.getUniformLocation(this.photoProgram, name),
        ]),
      );
      gl.uniform1i(gl.getUniformLocation(this.photoProgram, 'uPhoto'), 0);
      this.photoAttribute = gl.getAttribLocation(this.photoProgram, 'aCorner');
      this.photoBuffer = gl.createBuffer();
      resources.buffers.push(this.photoBuffer);
      if (this.vao) {
        this.photoVAO = this.vao.createVertexArrayOES();
        resources.vaos.push(this.photoVAO);
        this.vao.bindVertexArrayOES(this.photoVAO);
      } else for (const { loc } of this.particleAttributes) gl.disableVertexAttribArray(loc);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.photoBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
        gl.STATIC_DRAW,
      );
      gl.enableVertexAttribArray(this.photoAttribute);
      gl.vertexAttribPointer(this.photoAttribute, 2, gl.FLOAT, false, 8, 0);
      this.photoLayers = [[], []];
      for (const [name, entry] of photos) this.addPhoto(name, entry, false);
      if (gl.getError() !== gl.NO_ERROR) throw new Error('Space textures could not be uploaded');
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.clearColor(2 / 255, 6 / 255, 16 / 255, 1);
      reference.parentElement.insertBefore(this.canvas, reference.nextSibling);
      this.available = true;
      this.loseContext = () => {
        this.available = false;
        this.canvas.style.opacity = '0';
        onUnavailable?.();
      };
      this.canvas.addEventListener('webglcontextlost', this.loseContext, { once: true });
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  async prepareFlight(stars, textures) {
    const gl = this.gl,
      resources = this.resources;
    if (!this.available || this.program) return;
    try {
      const vertex = `
   precision highp float;
   attribute vec4 aStar;
   attribute vec4 aDepth;
   attribute vec2 aRetreat;
   attribute vec3 aQuad;
   uniform vec2 uViewport;
   uniform highp vec3 uProjection;
   uniform float uProgress;
   uniform highp float uMode;
   varying mediump vec2 vUV;
   varying mediump float vKind;
   varying mediump float vOpacity;
   varying mediump float vRadius;
   float smoothUnit(float x){x=clamp(x,0.,1.);return x*x*(3.-2.*x);}
   void main(){
    float t=uProgress,intensity=smoothUnit((t-.12)/.2)*(1.-smoothUnit((t-.73)/.23));
    float kind=aQuad.z,opacity=0.,radius=0.;vec2 point=vec2(0.);vUV=vec2(0.);
    if(kind>1.5){
     point=vec2(-5.,-615.)+vec2(aQuad.x,(aQuad.y+1.)*.5)*1760.;
     vUV=vec2(aQuad.x,(aQuad.y+1.)*.5);opacity=uMode<.5?intensity:0.;
    }else{
     vec2 endPoint,startPoint;float width,headRadius;bool showTail=true,showHead=true;
     if(uMode<.5){
      float z=fract(aStar.z+t*3.5),dist=aStar.w*(.045+z*z*z*4.8);
      float trailLength=min(460.,(26.+dist*.28)*intensity*(.2+z));
      endPoint=vec2(875.,265.)+aStar.xy*dist;
      startPoint=vec2(875.,265.)+aStar.xy*max(10.,dist-trailLength);
      opacity=smoothUnit(z/.15)*(1.-smoothUnit((z-.88)/.12))*intensity;
      if(intensity<.001||opacity<.001)opacity=0.;
      width=aDepth.x*(.5+z);headRadius=1.2;showHead=aDepth.x>1.8;
     }else{
      float start=.015+aDepth.z*.17,u=clamp((t-start)/.43,0.,1.);
      float scale=exp(-12.*smoothUnit(u)),previous=exp(-12.*smoothUnit((t-.012-start)/.43));
      float fade=smoothUnit(u/.10)*(1.-smoothUnit((u-.64)/.36))*(1.-smoothUnit((t-.80)/.17));
      float distance=aDepth.w*scale,previousDistance=aDepth.w*previous;
      fade*=smoothUnit((distance-8.)/50.);
      endPoint=vec2(800.,238.)+aRetreat*distance;
      float tailDistance=distance+min(90.,previousDistance-distance);
      startPoint=vec2(800.,238.)+aRetreat*tailDistance;
      opacity=fade*(.65+aDepth.y*.35);headRadius=.65+aDepth.x*.75*pow(scale,.07);width=headRadius;
      showTail=tailDistance-distance>.6;
      if(fade<.002||distance<4.)opacity=0.;
     }
     if(kind<.5){
      vec2 delta=endPoint-startPoint;float segmentLength=length(delta);vec2 direction=delta/max(segmentLength,.0001);
      radius=width*.5;float transverse=aQuad.y*(radius+.75/uProjection.x);
      point=mix(startPoint,endPoint,aQuad.x)+vec2(-direction.y,direction.x)*transverse;
      vUV=vec2(aQuad.x,transverse);if(!showTail||segmentLength<.01)opacity=0.;
     }else{
      radius=headRadius;vUV=vec2(aQuad.x*2.-1.,aQuad.y)*(radius+.75/uProjection.x);
      point=endPoint+vUV;if(!showHead)opacity=0.;else if(uMode<.5)opacity*=.7;
     }
    }
    vKind=kind;vOpacity=opacity;vRadius=radius;
    vec2 pixel=point*uProjection.x+uProjection.yz;
    gl_Position=vec4(pixel.x/uViewport.x*2.-1.,1.-pixel.y/uViewport.y*2.,0.,1.);
   }`;
      const fragment = `
   precision mediump float;
   uniform sampler2D uWarp;
   uniform sampler2D uRetreat;
   uniform sampler2D uHaze;
   uniform highp float uMode;
   uniform highp vec3 uProjection;
   varying mediump vec2 vUV;
   varying mediump float vKind;
   varying mediump float vOpacity;
   varying mediump float vRadius;
   void main(){
    if(vOpacity<.0001)discard;
    vec4 color;
    if(vKind>1.5){color=texture2D(uHaze,vUV);}
    else if(vKind<.5){
     color=uMode<.5?texture2D(uWarp,vec2(vUV.x,.5)):texture2D(uRetreat,vec2(vUV.x,.5));
     color*=clamp((vRadius-abs(vUV.y))*uProjection.x+.5,0.,1.);
    }else{
     float coverage=clamp((vRadius-length(vUV))*uProjection.x+.5,0.,1.);
     vec3 rgb=uMode<.5?vec3(220.,247.,255.)/255.:vec3(205.,232.,250.)/255.;color=vec4(rgb,1.)*coverage;
    }
    gl_FragColor=color*vOpacity;
   }`;
      // Linking validates both shaders; do not stop the queue after each compile.
      const vs = this.shader(gl.VERTEX_SHADER, vertex),
        fs = this.shader(gl.FRAGMENT_SHADER, fragment),
        program = gl.createProgram();
      resources.programs.push(program);
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      const parallel = gl.getExtension('KHR_parallel_shader_compile');
      const started = performance.now();
      if (parallel)
        while (!gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR)) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          if (this.disposed || gl.isContextLost() || performance.now() - started > 10000)
            throw new Error('Flight shader unavailable');
        }
      if (this.disposed || gl.isContextLost()) throw new Error('Flight context unavailable');
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error(gl.getProgramInfoLog(program));
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      resources.shaders.length = 0;
      gl.useProgram(program);
      this.program = program;
      this.uniforms = Object.fromEntries(
        ['uViewport', 'uProjection', 'uProgress', 'uMode'].map((name) => [
          name,
          gl.getUniformLocation(program, name),
        ]),
      );
      const corners = [
          [0, -1],
          [1, -1],
          [0, 1],
          [0, 1],
          [1, -1],
          [1, 1],
        ],
        vertices = [];
      const quad = (star, kind) => {
        for (const [x, y] of corners)
          vertices.push(
            star.dx,
            star.dy,
            star.z,
            star.r,
            star.w,
            star.c,
            star.layer,
            star.radius,
            star.rx,
            star.ry,
            x,
            y,
            kind,
          );
      };
      quad({ dx: 0, dy: 0, z: 0, r: 0, w: 0, c: 0, layer: 0, radius: 0, rx: 0, ry: 0 }, 2);
      for (const star of stars) {
        quad(star, 0);
        quad(star, 1);
      }
      this.count = vertices.length / 13;
      const buffer = gl.createBuffer();
      this.particleBuffer = buffer;
      resources.buffers.push(buffer);
      if (this.vao) {
        this.particleVAO = this.vao.createVertexArrayOES();
        resources.vaos.push(this.particleVAO);
        this.vao.bindVertexArrayOES(this.particleVAO);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
      this.particleAttributes = [
        ['aStar', 4, 0],
        ['aDepth', 4, 4],
        ['aRetreat', 2, 8],
        ['aQuad', 3, 10],
      ].map(([name, size, offset]) => ({ loc: gl.getAttribLocation(program, name), size, offset }));
      for (const { loc, size, offset } of this.particleAttributes) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 52, offset * 4);
      }
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      this.particleTextures = [];
      for (const [unit, name, texture] of [
        [0, 'uWarp', textures.warp],
        [1, 'uRetreat', textures.retreat],
        [2, 'uHaze', textures.haze],
      ]) {
        const textureObject = gl.createTexture();
        resources.textures.push(textureObject);
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, textureObject);
        this.particleTextures.push(textureObject);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, texture);
        gl.uniform1i(gl.getUniformLocation(program, name), unit);
      }

      if (this.projection) this.resize(...this.projection);
    } catch (error) {
      if (!this.disposed && this.available) this.loseContext?.();
      this.dispose();
      throw error;
    }
  }
  addPhoto(name, entry, verify = true) {
    const gl = this.gl;
    if (this.photoLayers[entry.layer].some((photo) => photo.name === name)) return;
    if (entry.width > this.maxTextureSize || entry.height > this.maxTextureSize)
      throw new Error('Photograph exceeds the supported texture size');
    const texture = gl.createTexture();
    this.resources.textures.push(texture);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      entry.uploadBitmap || entry.element,
    );
    if ((entry.width & (entry.width - 1)) === 0 && (entry.height & (entry.height - 1)) === 0) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    }
    // Initial assets form one checked batch. Later additions remain checked so
    // allocation failure still switches the entire scene to its safe fallback.
    if (verify && gl.getError() !== gl.NO_ERROR) {
      gl.deleteTexture(texture);
      throw new Error('Space texture could not be uploaded');
    }
    this.photoLayers[entry.layer].push({ name, entry, texture });
    // Later arrivals retain exactly the same occlusion order as initial artwork.
    this.photoLayers[entry.layer].sort((a, b) => a.entry.order - b.entry.order);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.available = false;
    const gl = this.gl,
      resources = this.resources;
    if (this.loseContext) this.canvas.removeEventListener('webglcontextlost', this.loseContext);
    for (const resource of resources.shaders) gl.deleteShader(resource);
    for (const resource of resources.programs) gl.deleteProgram(resource);
    for (const resource of resources.buffers) gl.deleteBuffer(resource);
    for (const resource of resources.textures) gl.deleteTexture(resource);
    for (const resource of resources.vaos) this.vao.deleteVertexArrayOES(resource);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.canvas.remove();
  }
  resize(width, height, scale, offsetX, offsetY) {
    this.projection = [width, height, scale, offsetX, offsetY];
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    const gl = this.gl;
    gl.viewport(0, 0, width, height);
    for (const [program, uniforms] of [
      [this.program, this.uniforms],
      [this.photoProgram, this.photoUniforms],
    ]) {
      if (!program) continue;
      gl.useProgram(program);
      gl.uniform2f(uniforms.uViewport, width, height);
      gl.uniform3f(uniforms.uProjection, scale, offsetX, offsetY);
    }
  }
  drawPhotos(layer, visible) {
    const gl = this.gl;
    gl.useProgram(this.photoProgram);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    if (this.vao) this.vao.bindVertexArrayOES(this.photoVAO);
    else {
      for (const { loc } of this.particleAttributes) gl.disableVertexAttribArray(loc);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.photoBuffer);
      gl.enableVertexAttribArray(this.photoAttribute);
      gl.vertexAttribPointer(this.photoAttribute, 2, gl.FLOAT, false, 8, 0);
    }
    gl.activeTexture(gl.TEXTURE0);
    // DOM creation order, not the order in which motion formulas emit sprites.
    for (const { name, entry, texture } of this.photoLayers[layer])
      if (visible.has(name)) {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform4fv(this.photoUniforms.uRect, entry.bounds);
        gl.uniform1f(this.photoUniforms.uAlpha, entry.alpha);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
  }
  drawParticles(progress) {
    if (!this.program) return;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_COLOR);
    if (this.vao) this.vao.bindVertexArrayOES(this.particleVAO);
    else {
      gl.disableVertexAttribArray(this.photoAttribute);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.particleBuffer);
      for (const { loc, size, offset } of this.particleAttributes) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 52, offset * 4);
      }
    }
    for (let unit = 0; unit < 3; unit++) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, this.particleTextures[unit]);
    }
    gl.uniform1f(this.uniforms.uMode, progress > 3 ? 1 : 0);
    gl.uniform1f(
      this.uniforms.uProgress,
      progress > 3 ? progress - 3 : window.JourneyScene.warpTime(progress - 2),
    );
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
  }
  render(progress, visible) {
    if (!this.available) return;
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.drawPhotos(0, visible);
    if (progress > 3 && progress < 4) this.drawParticles(progress);
    this.drawPhotos(1, visible);
    if (progress > 2 && progress <= 3) this.drawParticles(progress);
  }
};
