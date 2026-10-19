import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/volume-utils.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { scaleSamples, geometry, orientationCode, clampWindow, calculateVolumeRange, buildVolumeTexture, buildLabelTexture, looksLikeLabelMap, slicePlane, renderSlice, ORIENTATION_CODES, orientationMatrix, toothFairyLabelName, datasetLabelNames } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

test('negative scaling changes which voxel wins MIP', () => {
  assert.deepEqual([...scaleSamples([1, 4, 8], -2, 20)], [18, 12, 4]);
});
test('zero slope disables both slope and intercept', () => {
  assert.deepEqual([...scaleSamples([1, 4], 0, 200)], [1, 4]);
});
test('nonfinite voxels become finite background; all-invalid data rejected', () => {
  assert.deepEqual([...scaleSamples([NaN, 2, Infinity, -1], 1, 0)], [-1, 2, -1, -1]);
  assert.throws(() => scaleSamples([NaN, Infinity], 1, 0));
});
test('sform orientation, translation and spacing reproduce world coordinates', () => {
  const { spacing, matrix, unit } = geometry({ sform_code: 1, qform_code: 1,
    affine: [[0, -3, 0, 10], [2, 0, 0, 20], [0, 0, -4, 30], [0, 0, 0, 1]],
    xyzt_units: 2, getQformMat() { throw new Error('sform must win'); } });
  assert.deepEqual(spacing, [2, 3, 4]);
  const xyz = [2, 6, 12]; // voxel (1,2,3)
  assert.deepEqual([0, 1, 2].map(r => matrix[r] * xyz[0] + matrix[4+r] * xyz[1] + matrix[8+r] * xyz[2] + matrix[12+r]), [4, 22, 18]);
  assert.equal(orientationCode(matrix), 'ALI');
  assert.equal(unit, 'mm');
});
test('qform fallback and unknown spatial units', () => {
  const g = geometry({ sform_code: 0, qform_code: 1, xyzt_units: 0,
    getQformMat: () => [[2,0,0,0],[0,3,0,0],[0,0,4,0],[0,0,0,1]] });
  assert.deepEqual(g.spacing, [2,3,4]);
  assert.match(g.unit, /unspecified/);
});
test('window remains strictly ordered at both endpoints', () => {
  assert.deepEqual(clampWindow(1000, 1000, 'lower'), [999,1000]);
  assert.deepEqual(clampWindow(500, 0, 'upper'), [0,1]);
  assert.deepEqual(clampWindow(700, 300, 'lower'), [700,701]);
});
test('volume range applies scaling and ignores outliers for its default window', () => {
  const values = new Float32Array(1002).fill(10);
  values[0] = -1000;
  values[1001] = 2000;
  const range = calculateVolumeRange(values, 2, 5);
  assert.deepEqual([range.min, range.max], [-1995, 4005]);
  assert.equal(range.low, 25);
  assert.equal(range.high, 25 + 6);
});
test('3D texture downsamples each axis independently with box averages', () => {
  const values = Uint8Array.from({ length: 8 * 2 * 2 }, (_, index) => index);
  const texture = buildVolumeTexture(values, [8, 2, 2], 1, 0, { min: 0, max: 31 }, 4);
  assert.deepEqual(texture.dimensions, [4, 2, 2]);
  assert.deepEqual(texture.steps, [2, 1, 1]);
  assert.deepEqual([...texture.data.slice(0, 4)], [4, 21, 37, 53]);
});
test('label texture preserves foreground classes instead of averaging IDs', () => {
  const values = Uint8Array.from([
    0, 5, 0, 0,
    7, 5, 0, 9,
  ]);
  const texture = buildLabelTexture(values, [4, 2, 1], 1, 0, 2);
  assert.deepEqual(texture.dimensions, [2, 2, 1]);
  assert.deepEqual([...texture.data], [5, 0, 7, 9]);
  assert.deepEqual(texture.labels, [5, 7, 9]);
});
test('label-map heuristic accepts sparse classes and rejects continuous intensities', () => {
  assert.equal(looksLikeLabelMap([0, 0, 1, 2, 42], 1, 0), true);
  assert.equal(looksLikeLabelMap([0, 0.25, 1], 1, 0), false);
});
test('all 48 orientation codes build matrices that read back as the same code', () => {
  assert.equal(new Set(ORIENTATION_CODES).size, 48);
  assert.deepEqual(ORIENTATION_CODES.slice(0, 8), ['RAS', 'LAS', 'RPS', 'LPS', 'RAI', 'LAI', 'RPI', 'LPI']);
  for (const code of ORIENTATION_CODES) assert.equal(orientationCode(orientationMatrix(code)), code);
  assert.deepEqual([...orientationMatrix('ASL')], [0,1,0,0, 0,0,1,0, -1,0,0,0, 0,0,0,1]);
});
test('label list comes from full-resolution voxels, not downsampled winners', () => {
  assert.deepEqual(buildLabelTexture([2, 2, 3, 0], [4, 1, 1], 1, 0, 1).labels, [2, 3]);
});
test('ToothFairy names cover structures, FDI teeth and pulps only', () => {
  assert.equal(toothFairyLabelName(1), 'Lower Jawbone');
  assert.equal(toothFairyLabelName(18), 'Upper Right Third Molar (Wisdom Tooth)');
  assert.equal(toothFairyLabelName(36), 'Lower Left First Molar');
  assert.equal(toothFairyLabelName(105), 'Lingual Canal');
  assert.equal(toothFairyLabelName(141), 'Lower Right Central Incisor Pulp');
  for (const label of [0, 19, 50, 109, 149, 151, 211]) assert.equal(toothFairyLabelName(label), undefined);
});
test('dataset.json labels: nnU-Net name → id, MSD id → name, region lists skipped', () => {
  assert.deepEqual(datasetLabelNames({ background: 0, 'Lower Jawbone': 1, teeth: [11, 12] }), { 0: 'background', 1: 'Lower Jawbone' });
  assert.deepEqual(datasetLabelNames({ 0: 'background', 2: 'liver' }), { 0: 'background', 2: 'liver' });
  assert.equal(datasetLabelNames(undefined), null);
  assert.equal(datasetLabelNames({ teeth: [11, 12] }), null);
});
test('slices follow radiological convention for an LPS-stored volume', () => {
  // LPS storage (i -> L, j -> P, k -> S), 1 mm voxels, centred: world = diag(-1,-1,1)·(ijk - 1), so
  // world -> voxel is i = 1 - x, j = 1 - y, k = 1 + z.
  const worldToVoxel = [-1,0,0,0, 0,-1,0,0, 0,0,1,0, 1,1,1,1];
  const bright = (ijk) => { const values = new Float32Array(27); values[ijk[0] + 3 * ijk[1] + 9 * ijk[2]] = 100; return values; };
  const firstPixel = (plane, ijk, cursor) => {
    const spec = slicePlane(plane, worldToVoxel, [-1.5, -1.5, -1.5], [1.5, 1.5, 1.5], cursor, 1);
    const out = new Uint8ClampedArray(spec.width * spec.height * 4);
    renderSlice(out, spec, { values: bright(ijk), dimensions: [3, 3, 3], slope: 1, intercept: 0 }, 0, 100);
    assert.deepEqual([spec.width, spec.height], [3, 3]);
    return [...out].filter((_, i) => i % 4 === 0).indexOf(255);   // first bright pixel, row-major
  };
  assert.equal(firstPixel('axial', [0, 0, 1], [0, 0, 0]), 0);      // right-anterior: screen top-left
  assert.equal(firstPixel('coronal', [0, 1, 2], [0, 0, 0]), 0);    // right-superior: top-left
  assert.equal(firstPixel('sagittal', [1, 0, 2], [0, 0, 0]), 0);   // anterior-superior: top-left
  assert.equal(firstPixel('axial', [2, 2, 1], [0, 0, 0]), 8);      // left-posterior: bottom-right
  assert.equal(firstPixel('axial', [0, 0, 2], [0, 0, 1]), 0);      // cursor picks the superior slice
});
test('slice overlay blends visible labels and hides the rest', () => {
  const spec = slicePlane('axial', [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1], [-0.5, -0.5, -0.5], [1.5, 0.5, 0.5], [0, 0, 0], 1);
  const out = new Uint8ClampedArray(8);
  const colors = new Uint8Array(256 * 4); colors.set([200, 0, 0, 255], 4); colors.set([0, 200, 0, 0], 8);
  renderSlice(out, spec, { values: [50, 50], dimensions: [2, 1, 1], slope: 1, intercept: 0 }, 0, 100,
    { values: [1, 2], slope: 1, intercept: 0, colors, opacity: 0.5, only: false });
  assert.deepEqual([...out], [128, 128, 128, 255, 164, 64, 64, 255]);   // x=1 (label 2, hidden) on screen left
});
