'use strict';
// Developer-only capture from the production renderer, with no raster text.
window.HybridExport = function (physical, scene) {
  return {
    physical,
    scene,
    layer(name) {
      const p = physical,
        shadow = p.shadow.visible,
        optics = p.opticalMesh.visible,
        composite = p.compositeQuad.visible;
      const visibility = p.batchBindings.map((b) => b.visible);
      const modelVisibility = Object.fromEntries(
        Object.entries(p.models).map(([key, value]) => [key, value.model.visible]),
      );
      const mountVisibility = Object.fromEntries(
        Object.entries(p.mountGroups).map(([key, value]) => [key, value.visible]),
      );
      const geometry = p.opticalMesh.geometry,
        index = geometry.index,
        indices = index.array.slice(),
        drawRange = { ...geometry.drawRange };
      const part = (b) => {
        let a = b.source;
        while (a) {
          for (const k of ['center', 'left', 'right']) if (a === p.models[k].model) return k;
          a = a.parent;
        }
        return 'mounts';
      };
      for (const b of p.batchBindings)
        b.batch.setVisibleAt(
          b.instance,
          name === 'hardware' || name === 'glass' || part(b) === name,
        );
      // Single meshes are not in batchBindings. Hide their original hierarchy
      // too; otherwise adjacent screens leak into isolated export layers.
      for (const [key, value] of Object.entries(p.models))
        value.model.visible =
          modelVisibility[key] && (name === 'hardware' || name === 'glass' || name === key);
      for (const [key, value] of Object.entries(p.mountGroups))
        value.visible =
          mountVisibility[key] && (name === 'hardware' || name === 'glass' || name === 'mounts');
      p.shadow.visible = name === 'shadow';
      p.opticalMesh.visible = name === 'glass' || name === 'left' || name === 'right';
      if (name === 'left' || name === 'right') {
        const part = p.opticalParts[name === 'left' ? 1 : 2],
          source = part.cover.geometry.index;
        for (let i = 0; i < part.indexCount; i++)
          index.setX(i, part.vertexStart + (source ? source.getX(i) : i));
        geometry.setDrawRange(0, part.indexCount);
        index.needsUpdate = true;
      }
      p.renderer.setRenderTarget(p.hardwareTarget);
      p.renderer.clear(true, true, true);
      p.renderCamera.layers.set(0);
      p.renderer.render(p.scene, p.renderCamera);
      p.renderer.setRenderTarget(null);
      // Glass refraction samples the real hardware target. Keep that source
      // intact, but omit its final copy when exporting the optical layer.
      if (name === 'glass') {
        p.compositeQuad.visible = false;
        p.renderer.clear(true, true, true);
      }
      p.renderCamera.layers.set(1);
      p.renderer.render(p.opticsScene, p.renderCamera);
      p.renderCamera.layers.set(0);
      const data = p.renderer.domElement.toDataURL('image/png');
      for (const [key, value] of Object.entries(p.models))
        value.model.visible = modelVisibility[key];
      for (const [key, value] of Object.entries(p.mountGroups))
        value.visible = mountVisibility[key];
      index.array.set(indices);
      index.needsUpdate = true;
      geometry.setDrawRange(drawRange.start, drawRange.count);
      p.batchBindings.forEach((b, i) => b.batch.setVisibleAt(b.instance, visibility[i]));
      p.shadow.visible = shadow;
      p.opticalMesh.visible = optics;
      p.compositeQuad.visible = composite;
      p.poseKey = '';
      p.render();
      return {
        data,
        cropTop: p.cropTop,
        width: p.width,
        height: p.height,
        reader: p.rect.toJSON(),
        stage: p.stage.getBoundingClientRect().toJSON(),
        ratio: p.renderer.getPixelRatio(),
      };
    },
    exterior(name) {
      const image =
        name === 'nearStars'
          ? window.ObservatoryArt.foregroundStars()
          : window.ObservatoryArt.prepare(name, scene.assets[name]);
      return { data: image.toDataURL('image/png'), width: image.width, height: image.height };
    },
    sprite(name) {
      // Export one real GPU photograph, retaining the approved point sampling
      // instead of a prefiltered thumbnail. No cockpit or text is rasterized.
      const p = scene.particles,
        entry = scene.photos.get(name),
        [x, y, w, h] = entry.bounds;
      const left = Math.floor(scene.offsetX + x * scene.scale) - 1,
        top = Math.floor(scene.offsetY + y * scene.scale) - 1;
      const right = Math.ceil(scene.offsetX + (x + w) * scene.scale) + 1,
        bottom = Math.ceil(scene.offsetY + (y + h) * scene.scale) + 1;
      // Extend the same pixel grid beyond the viewport so a large Moon is a
      // complete responsive sprite, rather than a cropped viewport screenshot.
      p.resize(right - left, bottom - top, scene.scale, scene.offsetX - left, scene.offsetY - top);
      p.gl.clearColor(0, 0, 0, 0);
      p.gl.clear(p.gl.COLOR_BUFFER_BIT);
      p.drawPhotos(entry.layer, new Set([name]));
      const canvas = document.createElement('canvas');
      canvas.width = right - left;
      canvas.height = bottom - top;
      canvas.getContext('2d').drawImage(p.canvas, 0, 0);
      const data = canvas.toDataURL('image/png'),
        world = [
          (left - scene.offsetX) / scene.scale,
          (top - scene.offsetY) / scene.scale,
          canvas.width / scene.scale,
          canvas.height / scene.scale,
        ];
      p.gl.clearColor(2 / 255, 6 / 255, 16 / 255, 1);
      p.resize(scene.width, scene.height, scene.scale, scene.offsetX, scene.offsetY);
      scene.lastProgress = null;
      scene.render(0);
      return {
        data,
        world,
        raster: [scene.width, scene.height],
        viewport: [physical.width, physical.height],
        dpr: devicePixelRatio,
      };
    },
  };
};
