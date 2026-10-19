import type { NIFTI1, NIFTI2 } from 'nifti-reader-js';

// Apply scaling to the actual samples: scaling just labels gives incorrect
// maximum-intensity projections when scl_slope is negative.
export function scaleSamples(values: ArrayLike<number>, slope: number, intercept: number): Float32Array {
  const enabled = Number.isFinite(slope) && slope !== 0;
  const output = Float32Array.from(values, value => value * (enabled ? slope : 1)
    + (enabled && Number.isFinite(intercept) ? intercept : 0));
  let minimum = Infinity;
  for (const value of output) if (Number.isFinite(value)) minimum = Math.min(minimum, value);
  if (!Number.isFinite(minimum)) throw new Error('The volume does not contain finite scalar intensities.');
  for (let i = 0; i < output.length; i++) if (!Number.isFinite(output[i])) output[i] = minimum;
  return output;
}

export function geometry(header: NIFTI1 | NIFTI2) {
  // Explicit sform precedence; the reader's implicit choice is not identical
  // for all NIfTI versions. The normalized matrix orients the rendered box,
  // while voxel spacing is applied separately.
  const affine = header.sform_code > 0 ? header.affine
    : header.qform_code > 0 ? header.getQformMat()
      : [[Math.abs(header.pixDims[1]) || 1, 0, 0, 0],
        [0, Math.abs(header.pixDims[2]) || 1, 0, 0],
        [0, 0, Math.abs(header.pixDims[3]) || 1, 0], [0, 0, 0, 1]];
  const spacing = [0, 1, 2].map(c => Math.hypot(affine[0][c], affine[1][c], affine[2][c])) as [number, number, number];
  if (spacing.some(s => !Number.isFinite(s) || s <= 0) || affine.flat().some(v => !Number.isFinite(v))) {
    throw new Error('Invalid NIfTI spatial transform.');
  }
  const matrix = new Float32Array(16);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) matrix[c * 4 + r] = affine[r][c] / spacing[c];
  for (let r = 0; r < 3; r++) matrix[12 + r] = affine[r][3];
  matrix[15] = 1;
  const unit = ({1: 'm', 2: 'mm', 3: 'µm'} as Record<number, string>)[header.xyzt_units & 7] ?? 'units (unspecified)';
  return { spacing, matrix, unit };
}

/** Describe the direction of increasing voxel i/j/k axes in NIfTI RAS space. */
export function orientationCode(matrix: ArrayLike<number>): string {
  const positive = ['R', 'A', 'S'];
  const negative = ['L', 'P', 'I'];
  return [0, 1, 2].map(column => {
    let worldAxis = 0;
    for (let row = 1; row < 3; row++) {
      if (Math.abs(matrix[column * 4 + row]) > Math.abs(matrix[column * 4 + worldAxis])) worldAxis = row;
    }
    return matrix[column * 4 + worldAxis] >= 0 ? positive[worldAxis] : negative[worldAxis];
  }).join('');
}

const AXIS_LETTERS = ['RL', 'AP', 'SI'];

/** All 48 axis-aligned orientation codes, the 8 unpermuted ones (RAS, LAS, RPS, LPS, RAI, LAI, RPI, LPI) first. */
export const ORIENTATION_CODES = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]
  .flatMap(axes => [0, 1, 2, 3, 4, 5, 6, 7].map(signs =>
    axes.map((axis, column) => AXIS_LETTERS[axis][(signs >> column) & 1]).join('')));

/** Direction matrix (column-major 4×4) whose voxel i/j/k axes point toward the code's letters, e.g. 'LPI'. */
export function orientationMatrix(code: string): Float32Array {
  const matrix = new Float32Array(16);
  matrix[15] = 1;
  for (let column = 0; column < 3; column++) {
    const axis = AXIS_LETTERS.findIndex(letters => letters.includes(code[column]));
    matrix[column * 4 + axis] = AXIS_LETTERS[axis][0] === code[column] ? 1 : -1;
  }
  return matrix;
}

export function clampWindow(lower: number, upper: number, changed: 'lower' | 'upper'): [number, number] {
  lower = Math.max(0, Math.min(999, lower));
  upper = Math.max(1, Math.min(1000, upper));
  if (lower >= upper) {
    if (changed === 'lower') upper = lower + 1;
    else lower = upper - 1;
  }
  return [lower, upper];
}

export interface VolumeRange {
  min: number;
  max: number;
  low: number;
  high: number;
}

export interface VolumeTextureData {
  data: Uint8Array;
  dimensions: [number, number, number];
  steps: [number, number, number];
}

export interface LabelTextureData extends VolumeTextureData {
  labels: number[];
}

/**
 * Find both the true scalar range and a robust default display window without
 * allocating a sorted copy of a large CBCT volume.
 */
export function calculateVolumeRange(
  values: ArrayLike<number>,
  slope: number,
  intercept: number,
): VolumeRange {
  const scale = Number.isFinite(slope) && slope !== 0 ? slope : 1;
  const offset = scale === slope && Number.isFinite(intercept) ? intercept : 0;
  const stride = Math.max(1, Math.floor(values.length / 500_000));
  const sample: number[] = [];
  let min = Infinity;
  let max = -Infinity;

  for (let index = 0; index < values.length; index += 1) {
    const value = Number(values[index]) * scale + offset;
    if (!Number.isFinite(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
    if (index % stride === 0) sample.push(value);
  }
  if (!sample.length || !Number.isFinite(min) || !Number.isFinite(max)) {
    throw new Error('The volume does not contain finite scalar intensities.');
  }
  if (min === max) return { min, max: min + 1, low: min, high: min + 1 };

  sample.sort((a, b) => a - b);
  const at = (fraction: number) => sample[
    Math.min(sample.length - 1, Math.max(0, Math.floor((sample.length - 1) * fraction)))
  ];
  const low = at(0.005);
  const high = at(0.995);
  return { min, max, low, high: high > low ? high : low + (max - min) / 1000 };
}

/**
 * Box-average a volume into an 8-bit 3D texture. Each axis is reduced
 * independently, preserving detail on dimensions that are already small.
 */
export function buildVolumeTexture(
  values: ArrayLike<number>,
  dimensions: [number, number, number],
  slope: number,
  intercept: number,
  range: Pick<VolumeRange, 'min' | 'max'>,
  maxDimension = 256,
): VolumeTextureData {
  const [nx, ny, nz] = dimensions;
  const steps: [number, number, number] = [
    Math.max(1, Math.ceil(nx / maxDimension)),
    Math.max(1, Math.ceil(ny / maxDimension)),
    Math.max(1, Math.ceil(nz / maxDimension)),
  ];
  const outputDimensions: [number, number, number] = [
    Math.ceil(nx / steps[0]),
    Math.ceil(ny / steps[1]),
    Math.ceil(nz / steps[2]),
  ];
  const [dx, dy, dz] = outputDimensions;
  const output = new Uint8Array(dx * dy * dz);
  const scale = Number.isFinite(slope) && slope !== 0 ? slope : 1;
  const offset = scale === slope && Number.isFinite(intercept) ? intercept : 0;
  const span = range.max - range.min || 1;

  for (let oz = 0; oz < dz; oz += 1) {
    const zEnd = Math.min(nz, (oz + 1) * steps[2]);
    for (let oy = 0; oy < dy; oy += 1) {
      const yEnd = Math.min(ny, (oy + 1) * steps[1]);
      for (let ox = 0; ox < dx; ox += 1) {
        const xEnd = Math.min(nx, (ox + 1) * steps[0]);
        let sum = 0;
        let count = 0;
        for (let z = oz * steps[2]; z < zEnd; z += 1) {
          for (let y = oy * steps[1]; y < yEnd; y += 1) {
            const base = z * nx * ny + y * nx;
            for (let x = ox * steps[0]; x < xEnd; x += 1) {
              const value = Number(values[base + x]) * scale + offset;
              if (!Number.isFinite(value)) continue;
              sum += value;
              count += 1;
            }
          }
        }
        const value = count ? sum / count : range.min;
        output[ox + oy * dx + oz * dx * dy] = Math.max(
          0,
          Math.min(255, Math.round(((value - range.min) / span) * 255)),
        );
      }
    }
  }

  return { data: output, dimensions: outputDimensions, steps };
}

/**
 * Downsample a categorical label map without averaging class IDs. Any
 * foreground label wins over background, and the most frequent foreground
 * class in each source block is retained. This preserves thin structures.
 */
export function buildLabelTexture(
  values: ArrayLike<number>,
  dimensions: [number, number, number],
  slope: number,
  intercept: number,
  maxDimension = 256,
): LabelTextureData {
  const [nx, ny, nz] = dimensions;
  const steps: [number, number, number] = [
    Math.max(1, Math.ceil(nx / maxDimension)),
    Math.max(1, Math.ceil(ny / maxDimension)),
    Math.max(1, Math.ceil(nz / maxDimension)),
  ];
  const outputDimensions: [number, number, number] = [
    Math.ceil(nx / steps[0]),
    Math.ceil(ny / steps[1]),
    Math.ceil(nz / steps[2]),
  ];
  const [dx, dy, dz] = outputDimensions;
  const output = new Uint8Array(dx * dy * dz);
  const counts = new Uint16Array(256);
  const touched = new Uint8Array(256);
  // Listed from full-resolution voxels: a class that never wins a block still
  // shows in the full-resolution slices and must stay toggleable.
  const present = new Uint8Array(256);
  const scale = Number.isFinite(slope) && slope !== 0 ? slope : 1;
  const offset = scale === slope && Number.isFinite(intercept) ? intercept : 0;

  for (let oz = 0; oz < dz; oz += 1) {
    const zEnd = Math.min(nz, (oz + 1) * steps[2]);
    for (let oy = 0; oy < dy; oy += 1) {
      const yEnd = Math.min(ny, (oy + 1) * steps[1]);
      for (let ox = 0; ox < dx; ox += 1) {
        const xEnd = Math.min(nx, (ox + 1) * steps[0]);
        let touchedCount = 0;
        for (let z = oz * steps[2]; z < zEnd; z += 1) {
          for (let y = oy * steps[1]; y < yEnd; y += 1) {
            const base = z * nx * ny + y * nx;
            for (let x = ox * steps[0]; x < xEnd; x += 1) {
              const label = Math.max(0, Math.min(255, Math.round(Number(values[base + x]) * scale + offset)));
              if (!label) continue;
              present[label] = 1;
              if (counts[label] === 0) touched[touchedCount++] = label;
              counts[label] += 1;
            }
          }
        }
        let winner = 0;
        let winnerCount = 0;
        for (let index = 0; index < touchedCount; index += 1) {
          const label = touched[index];
          if (counts[label] > winnerCount) {
            winner = label;
            winnerCount = counts[label];
          }
          counts[label] = 0;
        }
        output[ox + oy * dx + oz * dx * dy] = winner;
      }
    }
  }
  const labels = [...present.keys()].filter(label => present[label]);
  return { data: output, dimensions: outputDimensions, steps, labels };
}

/** Conservative heuristic used only to pick the initial mask-only mode. */
export function looksLikeLabelMap(values: ArrayLike<number>, slope: number, intercept: number): boolean {
  const scale = Number.isFinite(slope) && slope !== 0 ? slope : 1;
  const offset = scale === slope && Number.isFinite(intercept) ? intercept : 0;
  const stride = Math.max(1, Math.floor(values.length / 500_000));
  const labels = new Set<number>();
  for (let index = 0; index < values.length; index += stride) {
    const value = Number(values[index]) * scale + offset;
    if (!Number.isFinite(value) || value < 0 || value > 255 || Math.abs(value - Math.round(value)) > 1e-5) return false;
    labels.add(Math.round(value));
    if (labels.size > 160) return false;
  }
  return labels.size > 1;
}

const TOOTH_NAMES = ['Central Incisor', 'Lateral Incisor', 'Canine', 'First Premolar', 'Second Premolar',
  'First Molar', 'Second Molar', 'Third Molar (Wisdom Tooth)'];
const QUADRANT_NAMES = ['Upper Right', 'Upper Left', 'Lower Left', 'Lower Right'];
const TOOTHFAIRY_STRUCTURES: Record<number, string> = {
  1: 'Lower Jawbone', 2: 'Upper Jawbone', 3: 'Left Inferior Alveolar Canal', 4: 'Right Inferior Alveolar Canal',
  5: 'Left Maxillary Sinus', 6: 'Right Maxillary Sinus', 7: 'Pharynx', 8: 'Bridge', 9: 'Crown', 10: 'Implant',
  103: 'Left Mandibular Incisive Canal', 104: 'Right Mandibular Incisive Canal', 105: 'Lingual Canal',
};

/** ToothFairy2/3 class name (FDI teeth 11–48, pulps 111–148); used when no dataset.json names the labels. */
export function toothFairyLabelName(label: number): string | undefined {
  if (TOOTHFAIRY_STRUCTURES[label]) return TOOTHFAIRY_STRUCTURES[label];
  const quadrant = QUADRANT_NAMES[Math.floor((label % 100) / 10) - 1];
  const tooth = TOOTH_NAMES[(label % 10) - 1];
  if (!quadrant || !tooth || label > 148) return undefined;
  return `${quadrant} ${tooth}${label > 100 ? ' Pulp' : ''}`;
}

/** Class names from a dataset.json `labels` object: nnU-Net (name → id) or MSD (id → name). */
export function datasetLabelNames(labels: unknown): Record<number, string> | null {
  const names: Record<number, string> = {};
  for (const [key, value] of Object.entries(labels ?? {})) {
    if (typeof value === 'number') names[value] = key;
    else if (typeof value === 'string' && /^\d+$/.test(key)) names[Number(key)] = value;
  }
  return Object.keys(names).length ? names : null;
}

export type Plane = 'axial' | 'coronal' | 'sagittal';

/**
 * Screen axes of each slice in the display (RAS) world, radiological
 * convention: patient right on screen left, anterior/superior up, sagittal
 * seen from the patient's left (anterior on the left).
 */
export const SLICE_AXES: Record<Plane, { u: number; uSign: number; v: number; vSign: number; normal: number }> = {
  axial: { u: 0, uSign: -1, v: 1, vSign: -1, normal: 2 },
  coronal: { u: 0, uSign: -1, v: 2, vSign: -1, normal: 1 },
  sagittal: { u: 1, uSign: -1, v: 2, vSign: -1, normal: 0 },
};


export interface SliceSpec {
  width: number;
  height: number;
  pixelSize: number;
  /** Display-world point at the centre of pixel (0, 0). */
  topLeft: number[];
  /** Voxel index at pixel (0, 0) and the voxel step per pixel along screen x and y. */
  origin: number[];
  stepX: number[];
  stepY: number[];
}

/** Pixel grid of the slice through `cursor`, covering the world bounds. */
export function slicePlane(
  plane: Plane,
  worldToVoxel: ArrayLike<number>,
  min: number[],
  max: number[],
  cursor: number[],
  pixelSize: number,
): SliceSpec {
  const { u, uSign, v, vSign } = SLICE_AXES[plane];
  const topLeft = [...cursor];
  topLeft[u] = (uSign < 0 ? max[u] : min[u]) + uSign * pixelSize / 2;
  topLeft[v] = (vSign < 0 ? max[v] : min[v]) + vSign * pixelSize / 2;
  const toVoxel = (point: number[], w: number) => [0, 1, 2].map(row => worldToVoxel[row] * point[0]
    + worldToVoxel[4 + row] * point[1] + worldToVoxel[8 + row] * point[2] + w * worldToVoxel[12 + row]);
  const along = (axis: number, length: number) => [0, 1, 2].map(a => (a === axis ? length : 0));
  return {
    width: Math.max(1, Math.round((max[u] - min[u]) / pixelSize)),
    height: Math.max(1, Math.round((max[v] - min[v]) / pixelSize)),
    pixelSize,
    topLeft,
    origin: toVoxel(topLeft, 1),
    stepX: toVoxel(along(u, uSign * pixelSize), 0),
    stepY: toVoxel(along(v, vSign * pixelSize), 0),
  };
}

interface ScaledVolume {
  values: ArrayLike<number>;
  dimensions: [number, number, number];
  slope: number;
  intercept: number;
}

/** Nearest-neighbour slice into RGBA: windowed grey plus an optional label overlay. */
export function renderSlice(
  out: Uint8ClampedArray,
  spec: SliceSpec,
  volume: ScaledVolume,
  low: number,
  high: number,
  mask?: Omit<ScaledVolume, 'dimensions'> & { colors: ArrayLike<number>; opacity: number; only: boolean },
): void {
  const [nx, ny, nz] = volume.dimensions;
  const span = high - low || 1;
  const { origin: o, stepX: sx, stepY: sy } = spec;
  // ponytail: ~45 ms for three full-res 512² CBCT slices; move to a WebGL slice shader if drags feel sluggish.
  for (let y = 0, p = 0; y < spec.height; y++) {
    for (let x = 0; x < spec.width; x++, p += 4) {
      const ix = Math.round(o[0] + x * sx[0] + y * sy[0]);
      const iy = Math.round(o[1] + x * sx[1] + y * sy[1]);
      const iz = Math.round(o[2] + x * sx[2] + y * sy[2]);
      let r = 0;
      let g = 0;
      let b = 0;
      if (ix >= 0 && iy >= 0 && iz >= 0 && ix < nx && iy < ny && iz < nz) {
        const index = ix + iy * nx + iz * nx * ny;
        if (!mask?.only) r = g = b = ((volume.values[index] * volume.slope + volume.intercept - low) / span) * 255;
        if (mask) {
          const label = Math.round(mask.values[index] * mask.slope + mask.intercept);
          const alpha = label > 0 && label < 256 ? (mask.colors[label * 4 + 3] / 255) * mask.opacity : 0;
          if (alpha) {
            r += (mask.colors[label * 4] - r) * alpha;
            g += (mask.colors[label * 4 + 1] - g) * alpha;
            b += (mask.colors[label * 4 + 2] - b) * alpha;
          }
        }
      }
      out[p] = r;
      out[p + 1] = g;
      out[p + 2] = b;
      out[p + 3] = 255;
    }
  }
}
