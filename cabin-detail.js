'use strict';

// Cabin metal and small instrument faces have separate raster budgets.
globalThis.CabinDetail = {
  density(width, height) {
    return window.ConsoleLayout.cabinDensity(
      width,
      height,
      devicePixelRatio,
      navigator.deviceMemory,
    );
  },
  stroke(c, path, color, width = 1) {
    c.strokeStyle = color;
    c.lineWidth = width;
    c.stroke(typeof path === 'string' ? new Path2D(path) : path);
  },
  ellipse(c, x, y, rx, ry, angle, color, width = 1) {
    c.beginPath();
    c.ellipse(x, y, rx, ry, angle, 0, Math.PI * 2);
    c.strokeStyle = color;
    c.lineWidth = width;
    c.stroke();
  },
  pool(c, x, y, rx, ry, color, strength = 1) {
    c.save();
    c.translate(x, y);
    c.scale(rx, ry);
    const light = c.createRadialGradient(0, 0, 0, 0, 0, 1);
    light.addColorStop(0, `rgba(${color.join(',')},${strength})`);
    light.addColorStop(0.35, `rgba(${color.join(',')},${strength * 0.66})`);
    light.addColorStop(1, `rgba(${color.join(',')},0)`);
    c.fillStyle = light;
    c.fillRect(-1, -1, 2, 2);
    c.restore();
  },
  geometry() {
    if (this.geometryCache) return this.geometryCache;
    const banks = [
      {
        x: 61,
        y: 824,
        width: 367,
        height: 130,
        path: new Path2D(
          'M124 825L412 826Q426 826 423 838L411 922Q407 933 392 942Q379 949 363 951L75 951Q62 951 63 938L78 857Q81 845 94 836Q108 827 124 825Z',
        ),
      },
      {
        x: 1174,
        y: 825,
        width: 373,
        height: 130,
        path: new Path2D(
          'M1189 827L1469 826C1483 828 1508 839 1518 852L1540 935Q1547 951 1528 952L1240 952Q1229 950 1221 944Q1199 932 1193 920L1177 839Q1173 827 1189 827Z',
        ),
      },
    ];
    // Static paths and moving lights use the same evenly spaced curve samples.
    const tracks = [];
    const makeTrack = (path, raw, color, size, duration, reverse, phase, bank) => {
      const lengths = [0];
      for (let i = 1; i < raw.length; i++)
        lengths.push(
          lengths[i - 1] + Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1]),
        );
      const points = [];
      let index = 1;
      for (let i = 0; i < 256; i++) {
        const at = (lengths[lengths.length - 1] * i) / 256;
        while (index < lengths.length - 1 && lengths[index] < at) index++;
        const mix = (at - lengths[index - 1]) / (lengths[index] - lengths[index - 1]);
        points.push([
          raw[index - 1][0] + (raw[index][0] - raw[index - 1][0]) * mix,
          raw[index - 1][1] + (raw[index][1] - raw[index - 1][1]) * mix,
        ]);
      }
      tracks.push({ path, points, color, size, duration, reverse, phase, bank });
    };
    const leftPath = new Path2D(),
      leftPoints = [],
      angle = (-13 * Math.PI) / 180;
    leftPath.ellipse(173, 881, 53, 25, angle, 0, Math.PI * 2);
    for (let i = 0; i <= 512; i++) {
      const t = (i / 512) * Math.PI * 2,
        x = Math.cos(t) * 53,
        y = Math.sin(t) * 25;
      leftPoints.push([
        173 + x * Math.cos(angle) - y * Math.sin(angle),
        881 + x * Math.sin(angle) + y * Math.cos(angle),
      ]);
    }
    makeTrack(leftPath, leftPoints, '#a8fff0', 2.6, 18000, false, 0.19, 0);
    const curve = (start, segments, color, size, duration, reverse, phase) => {
      const map = (p) => [1363 + (p[0] - 327.6) / 1.36, 882 + (p[1] - 99.52) / 1.36];
      const path = new Path2D(),
        raw = [],
        first = map(start);
      path.moveTo(...first);
      let p = start;
      for (const segment of segments) {
        const a = segment.slice(0, 2),
          b = segment.slice(2, 4),
          end = segment.slice(4, 6);
        path.bezierCurveTo(...map(a), ...map(b), ...map(end));
        for (let i = 0; i < 128; i++) {
          const t = i / 128,
            s = 1 - t;
          raw.push(
            map([
              s * s * s * p[0] + 3 * s * s * t * a[0] + 3 * s * t * t * b[0] + t * t * t * end[0],
              s * s * s * p[1] + 3 * s * s * t * a[1] + 3 * s * t * t * b[1] + t * t * t * end[1],
            ]),
          );
        }
        p = end;
      }
      path.closePath();
      raw.push(first);
      makeTrack(path, raw, color, size, duration, reverse, phase, 1);
    };
    curve(
      [158, 67],
      [
        [169, 31, 317, 52, 391, 76],
        [493, 109, 548, 133, 476, 143],
        [397, 153, 237, 116, 174, 82],
        [162, 77, 155, 72, 158, 67],
      ],
      '#9de9ff',
      3,
      27000,
      false,
      0.57,
    );
    curve(
      [230, 78],
      [
        [238, 34, 327, 26, 386, 59],
        [445, 91, 442, 138, 385, 145],
        [325, 151, 219, 116, 230, 78],
      ],
      '#ffc68c',
      2.2,
      34000,
      true,
      0.81,
    );
    const meters = Array.from({ length: 3 }, (_, row) => ({
      x: 301 - row * 10.5,
      y: 849 + row * 29.5,
      skew: -0.34,
    }));
    return (this.geometryCache = { banks, tracks, meters });
  },
  background(image, bank, index) {
    // Sample only quiet reflection areas. No old plotted marks survive.
    this.sampledColors ||= new WeakMap();
    if (!this.sampledColors.has(image)) {
      const sample = document.createElement('canvas');
      sample.width = 4;
      sample.height = 1;
      const sc = sample.getContext('2d', { willReadFrequently: true });
      // Identical 6x6-to-one-pixel samples, with a single readback shared by
      // both banks instead of four separate GPU synchronization points.
      [
        [190, 921],
        [360, 838],
        [1370, 930],
        [1400, 842],
      ].forEach(([x, y], i) => sc.drawImage(image, x - 3, y - 3, 6, 6, i, 0, 1, 1));
      const pixels = sc.getImageData(0, 0, 4, 1).data;
      this.sampledColors.set(
        image,
        Array.from({ length: 4 }, (_, i) => Array.from(pixels.slice(i * 4, i * 4 + 3))),
      );
    }
    const colors = this.sampledColors.get(image),
      warm = colors[index * 2],
      cool = colors[index * 2 + 1];
    const canvas = document.createElement('canvas');
    canvas.width = 192;
    canvas.height = 72;
    const c = canvas.getContext('2d');
    c.setTransform(
      192 / bank.width,
      0,
      0,
      72 / bank.height,
      (-bank.x * 192) / bank.width,
      (-bank.y * 72) / bank.height,
    );
    const glass = c.createLinearGradient(0, bank.y, 0, bank.y + bank.height);
    glass.addColorStop(0, '#01060a');
    glass.addColorStop(0.55, '#02080c');
    glass.addColorStop(1, '#010408');
    c.fillStyle = glass;
    c.fillRect(bank.x, bank.y, bank.width, bank.height);
    c.globalCompositeOperation = 'screen';
    this.pool(c, index ? 1372 : 194, 934, index ? 58 : 64, 90, warm, 1);
    this.pool(c, index ? 1400 : 332, 837, index ? 112 : 97, 83, cool, 0.9);
    this.pool(c, index ? 1280 : 100, bank.y + 6, 90, 18, [49, 92, 109], 0.13);
    return canvas;
  },
  point(c, x, y, color, radius = 2) {
    c.save();
    c.translate(x, y);
    c.scale(1, 0.65);
    this.pool(c, 0, 0, radius * 5.5, radius * 5.5, color, 0.33);
    this.pool(c, 0, 0, radius * 2.3, radius * 2.3, color, 0.6);
    c.fillStyle = `rgb(${color.join(',')})`;
    c.beginPath();
    c.arc(0, 0, radius, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = '#efffff';
    c.beginPath();
    c.ellipse(-0.3, -0.3, radius * 0.58, radius * 0.55, 0, 0, Math.PI * 2);
    c.fill();
    c.restore();
  },
  bankArtwork(c, index) {
    const { banks, tracks, meters } = this.geometry();
    c.save();
    c.lineJoin = 'round';
    c.lineCap = 'round';
    if (index === 0) {
      c.save();
      c.translate(173, 881);
      c.rotate((-13 * Math.PI) / 180);
      c.scale(1, 0.51);
      this.ellipse(c, 0, 0, 73, 73, 0, '#122b35', 3.4);
      this.ellipse(c, 0, 0, 71.5, 71.5, 0, '#87aab6', 1.2);
      this.ellipse(c, 0, 0, 69.5, 69.5, 0, '#2b8999', 1.1);
      this.ellipse(c, 0, 0, 64.5, 64.5, 0, 'rgba(61,216,231,.12)', 12);
      c.lineCap = 'butt';
      for (let i = 0; i < 64; i++) {
        const a = (i * Math.PI * 2) / 64;
        c.strokeStyle = i > 41 && i < 53 ? '#389bad' : '#bbf8fa';
        c.lineWidth = 3.9;
        c.beginPath();
        c.moveTo(Math.cos(a) * 61, Math.sin(a) * 61);
        c.lineTo(Math.cos(a) * 68, Math.sin(a) * 68);
        c.stroke();
      }
      this.ellipse(c, 0, 0, 58, 58, 0, '#3a9ba7', 0.8);
      for (const r of [34, 52]) this.ellipse(c, 0, 0, r, r, 0, '#164553', 0.7);
      this.stroke(c, 'M-55 0H55M0-55V55', '#174754', 0.65);
      c.restore();
      this.point(c, 173, 881, [142, 228, 238], 1.15);
      for (const row of meters) {
        c.save();
        c.transform(1, 0, row.skew, 1, row.x, row.y);
        this.pool(c, 36, 5, 55, 16, [50, 190, 208], 0.15);
        for (let n = 0; n < 10; n++) {
          const fill = c.createLinearGradient(0, 0, 0, 10);
          fill.addColorStop(0, n < 8 ? '#b3f6fa' : '#103b4c');
          fill.addColorStop(1, n < 8 ? '#54bfce' : '#092a39');
          c.fillStyle = fill;
          c.fillRect(n * 9.7, 0, 7.7, 9.6);
          if (n < 8) {
            c.fillStyle = 'rgba(225,255,255,.65)';
            c.fillRect(n * 9.7 + 0.55, 0.6, 0.75, 8.1);
          }
        }
        c.restore();
      }
    } else {
      c.save();
      c.strokeStyle = '#0c3b4c';
      c.lineWidth = 0.65;
      for (let n = 0; n < 8; n++) {
        c.beginPath();
        c.moveTo(1230 + n * 29, 834);
        c.lineTo(1269 + n * 29, 925);
        c.stroke();
      }
      for (let n = 0; n < 6; n++) {
        c.beginPath();
        c.moveTo(1226 + n * 7, 839 + n * 16);
        c.lineTo(1467 + n * 7, 840 + n * 16);
        c.stroke();
      }
      c.restore();
      for (const track of tracks.slice(1)) {
        this.stroke(c, track.path, 'rgba(65,204,218,.12)', 4.2);
        this.stroke(c, track.path, '#85dce3', 1.2);
        this.stroke(c, track.path, 'rgba(203,253,255,.7)', 0.38);
      }
      const amber = new Path2D('M1379 844C1427 861 1427 887 1386 903C1364 914 1338 913 1312 897');
      c.save();
      c.setLineDash([2.4, 4.1]);
      this.stroke(c, amber, 'rgba(255,166,57,.22)', 4.4);
      this.stroke(c, amber, '#ffd18b', 1.6);
      c.restore();
      this.stroke(c, 'M1261 909 1266 921M1258 915H1274', '#84d9df', 1.2);
      this.point(c, 1312, 897, [151, 246, 255], 4.3);
      this.point(c, 1379, 844, [255, 186, 116], 2.65);
      this.point(c, 1468, 883, [211, 168, 255], 4);
    }
    // Follow the original glass lip, with the bright part on its upper edge.
    // The outside metal remains untouched; this is an inset optical edge.
    const rim = c.createLinearGradient(0, banks[index].y, 0, banks[index].y + banks[index].height);
    rim.addColorStop(0, 'rgba(135,184,200,.48)');
    rim.addColorStop(0.15, 'rgba(80,115,133,.17)');
    rim.addColorStop(0.85, 'rgba(28,45,54,.3)');
    rim.addColorStop(1, 'rgba(134,159,171,.28)');
    this.stroke(c, banks[index].path, '#09141b', 2.2);
    this.stroke(c, banks[index].path, rim, 1.1);
    c.restore();
  },
  paint(c) {
    c.save();
    c.lineJoin = 'round';
    c.lineCap = 'round';
    this.stroke(c, 'M107 99 151 46H1446L1491 99', 'rgba(193,225,230,.35)', 0.8);
    this.stroke(c, 'M110 99 173 718M1490 99 1427 718', 'rgba(124,208,222,.35)', 0.8);
    this.stroke(c, 'M49 973H393L469 938H1131L1207 973H1551', 'rgba(170,195,207,.25)', 0.85);
    c.restore();
  },
  strip(c) {
    c.save();
    c.lineJoin = 'round';
    c.lineCap = 'round';
    const shade = c.createLinearGradient(120, 12, 150, 51);
    shade.addColorStop(0, '#020b11');
    shade.addColorStop(0.55, '#07121a');
    shade.addColorStop(1, '#03090f');
    c.fillStyle = shade;
    c.fillRect(120, 12, 376, 39);
    // Keep original housing and warm bloom. Scope cyan glow to icons only.
    c.save();
    c.shadowColor = '#69dae6';
    c.shadowBlur = 2;
    this.ellipse(c, 160, 32, 9, 9, -0.45, '#9eeff3', 1.5);
    this.ellipse(c, 160, 32, 16, 5, -0.45, '#c3fcff', 1.5);
    this.stroke(
      c,
      'M310 19 300 42H320ZM310 19V39L300 42M310 39 320 42M310 26 305 37H315Z',
      '#a6f4f4',
      1.2,
    );
    this.ellipse(c, 460, 32, 9, 9, 0, '#a6f4f4', 1.5);
    this.ellipse(c, 460, 32, 3, 3, 0, '#b9ffff', 1.2);
    this.stroke(c, 'M460 19V25M460 39V45M447 32H453M467 32H473', '#b9ffff', 1.3);
    for (const start of [199, 352])
      for (let n = 0; n < 8; n++) {
        c.fillStyle = n > 2 && n < 7 ? '#b2f9fa' : '#174453';
        c.fillRect(start + n * 11, 30, 3, 5);
      }
    c.restore();
    for (const x of [12, 503]) {
      c.fillStyle = '#fff3c6';
      c.fillRect(x + 9, 13, 76, 7);
      this.stroke(c, `M${x + 9} 12h76`, '#fffdf1', 0.8);
    }
    this.stroke(c, 'M3 55H615', '#9ceff4', 1.1);
    c.restore();
  },
};
