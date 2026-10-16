import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VolumeRenderShader1 } from 'three/examples/jsm/shaders/VolumeShader.js';
import * as nifti from 'nifti-reader-js';
import {
  buildVolumeTexture,
  buildLabelTexture,
  calculateVolumeRange,
  geometry,
  looksLikeLabelMap,
  looksUpsideDown,
  orientationCode,
  renderSlice,
  slicePlane,
  SLICE_AXES,
  type Plane,
  type SliceSpec,
  type LabelTextureData,
  type VolumeRange,
  type VolumeTextureData,
} from './volume-utils';

type RenderStyle = 'mip' | 'amip' | 'iso';
type AxisOrder = 'xyz' | 'yxz' | 'xzy' | 'zyx' | 'yzx' | 'zxy';
type DisplayMode = 'cbct' | 'mask' | 'overlay';
type ScalarArray =
  | Uint8Array | Int8Array | Uint16Array | Int16Array
  | Uint32Array | Int32Array | Float32Array | Float64Array;

interface LoadedVolume {
  values: ScalarArray;
  dimensions: [number, number, number];
  spacing: [number, number, number];
  direction: Float32Array;
  range: VolumeRange;
  slope: number;
  intercept: number;
  datatype: string;
  orientation: string;
  transformSource: string;
  upsideDown: boolean;
  hasExtraFrames: boolean;
  unit: string;
}

interface VolumeView {
  setClim(low: number, high: number): void;
  setStyle(style: RenderStyle): void;
  setThreshold(value: number): void;
  setInteractive(active: boolean): void;
  setAxisOrder(order: AxisOrder): void;
  setRas(ras: boolean): void;
  setMask(mask: LabelTextureData): void;
  setDisplayMode(mode: DisplayMode): void;
  setMaskOpacity(opacity: number): void;
  setHiddenLabels(labels: Iterable<number>): void;
  resetView(): void;
  /** Display presentation (LAS mirror · axis swap) and the full volume placement. */
  matrices(): { presentation: THREE.Matrix4; volume: THREE.Matrix4 };
  setAxialView(): void;
  requestRender(): void;
  dispose(): void;
}

const MAX_TEXTURE_DIMENSION = 256;
const app = requiredElement<HTMLElement>('app');
const viewport = requiredElement<HTMLElement>('viewport');
const view3d = requiredElement<HTMLElement>('view3d');
const layoutControl = requiredElement<HTMLButtonElement>('layout-toggle');
const SLICE_PLANES: Plane[] = ['axial', 'coronal', 'sagittal'];
// Slicer-style plane colours; each crosshair line takes the colour of the plane it marks.
const PLANE_COLORS: Record<Plane, string> = { axial: '#f06a5f', coronal: '#62c370', sagittal: '#e8c547' };
const PLANE_WITH_NORMAL: Plane[] = ['sagittal', 'coronal', 'axial'];
const sliceCanvases = Object.fromEntries(SLICE_PLANES.map(plane =>
  [plane, requiredElement<HTMLCanvasElement>(`slice-${plane}`)])) as Record<Plane, HTMLCanvasElement>;
const sliceScratch = document.createElement('canvas');
const loading = requiredElement<HTMLElement>('loading');
const loadingMessage = requiredElement<HTMLElement>('loading-message');
const errorBox = requiredElement<HTMLElement>('error');
const metadata = requiredElement<HTMLElement>('metadata');
const styleControl = requiredElement<HTMLSelectElement>('render-style');
const axisOrderControl = requiredElement<HTMLSelectElement>('axis-order');
const orientationControl = requiredElement<HTMLButtonElement>('orientation-toggle');
const levelControl = requiredElement<HTMLInputElement>('level');
const windowControl = requiredElement<HTMLInputElement>('window');
const thresholdControl = requiredElement<HTMLInputElement>('threshold');
const thresholdLabel = requiredElement<HTMLElement>('threshold-label');
const levelOutput = requiredElement<HTMLOutputElement>('level-value');
const windowOutput = requiredElement<HTMLOutputElement>('window-value');
const thresholdOutput = requiredElement<HTMLOutputElement>('threshold-value');
const displayModeControl = requiredElement<HTMLSelectElement>('display-mode');
const loadMaskControl = requiredElement<HTMLButtonElement>('load-mask');
const maskName = requiredElement<HTMLElement>('mask-name');
const maskOpacityControl = requiredElement<HTMLInputElement>('mask-opacity');
const maskOpacityOutput = requiredElement<HTMLOutputElement>('mask-opacity-value');
const maskOpacityLabel = requiredElement<HTMLElement>('mask-opacity-label');
const maskLegend = requiredElement<HTMLElement>('mask-legend');
const legendLabels = requiredElement<HTMLElement>('legend-labels');
const legendAllControl = requiredElement<HTMLButtonElement>('legend-all');
const legendNoneControl = requiredElement<HTMLButtonElement>('legend-none');
const resetContrastControl = requiredElement<HTMLButtonElement>('reset-contrast');

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;

let loaded: LoadedVolume | undefined;
let volumeView: VolumeView | undefined;
let level = 0;
let width = 1;
let ras = true;
let disposed = false;
let externalMaskLoaded = false;
let currentMaskPrepared = false;
const hiddenLabels = new Set<number>();
let maskSource: LoadedVolume | undefined;
let quad = false;
const cursor = [0, 0, 0];
let sliceGeometry: SliceGeometry | undefined;
let sliceFrame: number | undefined;
const sliceLayouts = new Map<Plane, { spec: SliceSpec; scale: number; left: number; top: number }>();

styleControl.addEventListener('change', () => {
  const style = styleControl.value as RenderStyle;
  thresholdLabel.hidden = style !== 'iso';
  volumeView?.setStyle(style);
});
axisOrderControl.addEventListener('change', () => {
  volumeView?.setAxisOrder(axisOrderControl.value as AxisOrder);
  drawSlices();
});
orientationControl.addEventListener('click', () => {
  ras = !ras;
  syncOrientationControl();
  volumeView?.setRas(ras);
  drawSlices();
});
layoutControl.addEventListener('click', () => {
  quad = !quad;
  app.classList.toggle('quad', quad);
  layoutControl.setAttribute('aria-pressed', String(quad));
  drawSlices();
});
for (const plane of SLICE_PLANES) {
  const canvas = sliceCanvases[plane];
  canvas.addEventListener('pointerdown', event => {
    canvas.setPointerCapture(event.pointerId);
    moveCursor(plane, event);
  });
  canvas.addEventListener('pointermove', event => {
    if (event.buttons & 1) moveCursor(plane, event);
  });
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    if (!sliceGeometry) return;
    const axis = SLICE_AXES[plane].normal;
    cursor[axis] -= Math.sign(event.deltaY) * sliceGeometry.step[axis];
    clampCursor();
    drawSlices();
  }, { passive: false });
}
new ResizeObserver(() => drawSlices()).observe(viewport);
displayModeControl.addEventListener('change', () => void applyDisplayMode());
loadMaskControl.addEventListener('click', () => vscodeApi?.postMessage({ type: 'selectMask' }));
maskOpacityControl.addEventListener('input', () => {
  const opacity = Number(maskOpacityControl.value) / 100;
  maskOpacityOutput.value = `${Math.round(opacity * 100)}%`;
  volumeView?.setMaskOpacity(opacity);
  drawSlices();
});
maskOpacityControl.addEventListener('pointerdown', () => volumeView?.setInteractive(true));
maskOpacityControl.addEventListener('pointerup', () => volumeView?.setInteractive(false));
maskOpacityControl.addEventListener('pointercancel', () => volumeView?.setInteractive(false));
legendAllControl.addEventListener('click', () => setAllLabelsVisible(true));
legendNoneControl.addEventListener('click', () => setAllLabelsVisible(false));
levelControl.addEventListener('input', updateWindowFromControls);
windowControl.addEventListener('input', updateWindowFromControls);
thresholdControl.addEventListener('input', () => {
  const value = Number(thresholdControl.value) / 100;
  thresholdOutput.value = `${Math.round(value * 100)}%`;
  volumeView?.setThreshold(value);
});
[levelControl, windowControl, thresholdControl].forEach(control => {
  control.addEventListener('pointerdown', () => volumeView?.setInteractive(true));
  control.addEventListener('pointerup', () => volumeView?.setInteractive(false));
  control.addEventListener('pointercancel', () => volumeView?.setInteractive(false));
  control.addEventListener('change', () => volumeView?.setInteractive(false));
});
requiredElement<HTMLButtonElement>('reset-camera').addEventListener('click', () => volumeView?.resetView());
requiredElement<HTMLButtonElement>('axial-camera').addEventListener('click', () => volumeView?.setAxialView());
resetContrastControl.addEventListener('click', resetContrast);

window.addEventListener('message', event => {
  const message = event.data as { type?: string; uri?: string; filename?: string };
  if (message?.type === 'maskSelected' && message.uri) {
    void loadExternalMask(message.uri, message.filename ?? 'Segmentation mask');
  }
});

void loadVolume();

async function loadVolume(): Promise<void> {
  try {
    setLoading('Reading volume…');
    const response = await fetch(app.dataset.volumeUri ?? '');
    if (!response.ok) throw new Error(`Unable to read the file (${response.status} ${response.statusText}).`);
    let fileData = await response.arrayBuffer();
    if (fileData.byteLength < 2) throw new Error('The NIfTI file is empty or truncated.');

    if (nifti.isCompressed(fileData)) {
      setLoading('Decompressing .nii.gz…');
      await nextFrame();
      fileData = await nifti.decompressAsync(fileData);
    }
    if (!nifti.isNIFTI(fileData)) {
      throw new Error('This file is not a valid single-file NIfTI-1 or NIfTI-2 volume.');
    }

    setLoading('Analysing intensities…');
    await nextFrame();
    loaded = parseNifti(fileData);
    configureControls(loaded);

    setLoading('Building responsive 3D texture…');
    await nextFrame();
    const texture = buildVolumeTexture(
      loaded.values,
      loaded.dimensions,
      loaded.slope,
      loaded.intercept,
      loaded.range,
      MAX_TEXTURE_DIMENSION,
    );
    if (disposed) return;
    volumeView = createVolumeView(view3d, loaded, texture);
    applyClim();
    volumeView.setStyle(styleControl.value as RenderStyle);
    volumeView.setThreshold(Number(thresholdControl.value) / 100);
    volumeView.setAxisOrder(axisOrderControl.value as AxisOrder);
    volumeView.setRas(ras);
    volumeView.setMaskOpacity(Number(maskOpacityControl.value) / 100);
    if (looksLikeLabelMap(loaded.values, loaded.slope, loaded.intercept)) {
      displayModeControl.value = 'mask';
      await prepareCurrentAsMask();
    } else {
      displayModeControl.value = 'cbct';
      volumeView.setDisplayMode('cbct');
    }
    syncMaskControls();
    loading.hidden = true;
  } catch (error) {
    showError(error);
  }
}

function parseNifti(data: ArrayBuffer): LoadedVolume {
  const header = nifti.readHeader(data);
  const dimensions: [number, number, number] = [header.dims[1], header.dims[2], header.dims[3]];
  if (dimensions.some(dimension => !Number.isInteger(dimension) || dimension < 2)) {
    throw new Error(`Expected a 3D NIfTI volume, received dimensions ${dimensions.join(' × ')}.`);
  }
  const voxelCount = dimensions[0] * dimensions[1] * dimensions[2];
  if (!Number.isSafeInteger(voxelCount)) throw new Error('The NIfTI dimensions are too large.');
  const image = nifti.readImage(header, data);
  const values = readScalars(image, header.datatypeCode, header.littleEndian, voxelCount);
  const slope = Number.isFinite(header.scl_slope) && header.scl_slope !== 0 ? header.scl_slope : 1;
  const intercept = slope === header.scl_slope && Number.isFinite(header.scl_inter) ? header.scl_inter : 0;
  const spatial = geometry(header);
  const range = calculateVolumeRange(values, slope, intercept);

  return {
    values,
    dimensions,
    spacing: spatial.spacing,
    direction: spatial.matrix,
    range,
    slope,
    intercept,
    datatype: header.getDatatypeCodeString(header.datatypeCode),
    orientation: orientationCode(spatial.matrix),
    transformSource: header.sform_code > 0 ? 'sform' : header.qform_code > 0 ? 'qform' : 'pixdim fallback',
    upsideDown: looksUpsideDown(values, dimensions, spatial.matrix, slope, intercept,
      looksLikeLabelMap(values, slope, intercept) ? undefined : range),
    hasExtraFrames: header.dims.slice(4, header.dims[0] + 1).some(dimension => dimension > 1),
    unit: spatial.unit,
  };
}

function readScalars(
  buffer: ArrayBuffer,
  datatype: number,
  littleEndian: boolean,
  count: number,
): ScalarArray {
  const bytes = bytesForDatatype(datatype);
  if (buffer.byteLength < count * bytes) throw new Error('The NIfTI image payload is truncated.');
  if (littleEndian || bytes === 1) {
    switch (datatype) {
      case nifti.NIFTI1.TYPE_UINT8: return new Uint8Array(buffer, 0, count);
      case nifti.NIFTI1.TYPE_INT8: return new Int8Array(buffer, 0, count);
      case nifti.NIFTI1.TYPE_UINT16: return new Uint16Array(buffer, 0, count);
      case nifti.NIFTI1.TYPE_INT16: return new Int16Array(buffer, 0, count);
      case nifti.NIFTI1.TYPE_UINT32: return new Uint32Array(buffer, 0, count);
      case nifti.NIFTI1.TYPE_INT32: return new Int32Array(buffer, 0, count);
      case nifti.NIFTI1.TYPE_FLOAT32: return new Float32Array(buffer, 0, count);
      case nifti.NIFTI1.TYPE_FLOAT64: return new Float64Array(buffer, 0, count);
      default: throw unsupportedDatatype(datatype);
    }
  }

  const view = new DataView(buffer);
  switch (datatype) {
    case nifti.NIFTI1.TYPE_UINT16: return copyEndian(count, 2, offset => view.getUint16(offset, false), Uint16Array);
    case nifti.NIFTI1.TYPE_INT16: return copyEndian(count, 2, offset => view.getInt16(offset, false), Int16Array);
    case nifti.NIFTI1.TYPE_UINT32: return copyEndian(count, 4, offset => view.getUint32(offset, false), Uint32Array);
    case nifti.NIFTI1.TYPE_INT32: return copyEndian(count, 4, offset => view.getInt32(offset, false), Int32Array);
    case nifti.NIFTI1.TYPE_FLOAT32: return copyEndian(count, 4, offset => view.getFloat32(offset, false), Float32Array);
    case nifti.NIFTI1.TYPE_FLOAT64: return copyEndian(count, 8, offset => view.getFloat64(offset, false), Float64Array);
    default: throw unsupportedDatatype(datatype);
  }
}

function copyEndian<T extends ScalarArray>(
  count: number,
  stride: number,
  getter: (offset: number) => number,
  Constructor: { new(length: number): T },
): T {
  const output = new Constructor(count);
  for (let index = 0; index < count; index += 1) output[index] = getter(index * stride);
  return output;
}

function bytesForDatatype(datatype: number): number {
  switch (datatype) {
    case nifti.NIFTI1.TYPE_UINT8:
    case nifti.NIFTI1.TYPE_INT8: return 1;
    case nifti.NIFTI1.TYPE_UINT16:
    case nifti.NIFTI1.TYPE_INT16: return 2;
    case nifti.NIFTI1.TYPE_UINT32:
    case nifti.NIFTI1.TYPE_INT32:
    case nifti.NIFTI1.TYPE_FLOAT32: return 4;
    case nifti.NIFTI1.TYPE_FLOAT64: return 8;
    default: throw unsupportedDatatype(datatype);
  }
}

function unsupportedDatatype(datatype: number): Error {
  return new Error(`Unsupported NIfTI datatype code ${datatype}. Use a scalar integer or floating-point volume.`);
}

function configureControls(volume: LoadedVolume): void {
  level = (volume.range.low + volume.range.high) / 2;
  width = Math.max((volume.range.max - volume.range.min) / 1000, volume.range.high - volume.range.low);
  syncControls();
  metadata.textContent = [
    volume.dimensions.join(' × '),
    `${volume.spacing.map(formatNumber).join(' × ')} ${volume.unit}`,
    volume.datatype,
    `${volume.transformSource} ${volume.orientation}${volume.upsideDown ? ' (S/I auto-flipped)' : ''}`,
    `GPU ${buildPreviewSize(volume.dimensions).join(' × ')}`,
    volume.hasExtraFrames ? 'first 3D frame' : '',
  ].filter(Boolean).join(' · ');
}

function syncOrientationControl(): void {
  orientationControl.classList.toggle('active', ras);
  orientationControl.setAttribute('aria-checked', String(ras));
  orientationControl.setAttribute('aria-label', `Orientation: ${ras ? 'RAS' : 'LAS'}`);
}

async function prepareCurrentAsMask(): Promise<void> {
  if (!loaded || !volumeView || currentMaskPrepared) return;
  setLoading('Preparing segmentation labels…');
  await nextFrame();
  const mask = buildLabelTexture(
    loaded.values,
    loaded.dimensions,
    loaded.slope,
    loaded.intercept,
    MAX_TEXTURE_DIMENSION,
  );
  volumeView.setMask(mask);
  maskSource = loaded;
  currentMaskPrepared = true;
  maskName.textContent = `${app.dataset.filename ?? 'Current volume'} · ${mask.labels.length} labels`;
  renderMaskLegend(mask.labels);
  volumeView.setDisplayMode('mask');
}

async function applyDisplayMode(): Promise<void> {
  if (!volumeView) return;
  let mode = displayModeControl.value as DisplayMode;
  if (mode === 'overlay' && !externalMaskLoaded) {
    maskName.textContent = 'Load a matching mask for overlay';
    vscodeApi?.postMessage({ type: 'selectMask' });
    displayModeControl.value = 'cbct';
    mode = 'cbct';
  } else if (mode === 'mask' && !externalMaskLoaded) {
    await prepareCurrentAsMask();
  }
  volumeView.setDisplayMode(mode);
  drawSlices();
  syncMaskControls();
  loading.hidden = true;
}

async function loadExternalMask(uri: string, filename: string): Promise<void> {
  if (!loaded || !volumeView) return;
  try {
    setLoading('Reading segmentation mask…');
    const response = await fetch(uri);
    if (!response.ok) throw new Error(`Unable to read the mask (${response.status} ${response.statusText}).`);
    let data = await response.arrayBuffer();
    if (nifti.isCompressed(data)) {
      setLoading('Decompressing segmentation mask…');
      await nextFrame();
      data = await nifti.decompressAsync(data);
    }
    if (!nifti.isNIFTI(data)) throw new Error('The selected mask is not a valid NIfTI volume.');
    const maskVolume = parseNifti(data);
    validateMaskAlignment(loaded, maskVolume);
    setLoading('Preparing segmentation labels…');
    await nextFrame();
    const mask = buildLabelTexture(
      maskVolume.values,
      maskVolume.dimensions,
      maskVolume.slope,
      maskVolume.intercept,
      MAX_TEXTURE_DIMENSION,
    );
    volumeView.setMask(mask);
    maskSource = maskVolume;
    externalMaskLoaded = true;
    maskName.textContent = `${filename} · ${mask.labels.length} labels`;
    renderMaskLegend(mask.labels);
    displayModeControl.value = 'overlay';
    volumeView.setDisplayMode('overlay');
    syncMaskControls();
  } catch (error) {
    maskName.textContent = error instanceof Error ? error.message : String(error);
    console.error(error);
  } finally {
    loading.hidden = true;
  }
}

function validateMaskAlignment(base: LoadedVolume, mask: LoadedVolume): void {
  if (base.dimensions.some((dimension, axis) => dimension !== mask.dimensions[axis])) {
    throw new Error(`Mask dimensions ${mask.dimensions.join(' × ')} do not match CBCT ${base.dimensions.join(' × ')}.`);
  }
  if (base.spacing.some((spacing, axis) => Math.abs(spacing - mask.spacing[axis]) > 1e-4)
      || [...base.direction].some((value, index) => Math.abs(value - mask.direction[index]) > 1e-4)) {
    throw new Error('Mask spatial metadata does not match the open CBCT.');
  }
}

function syncMaskControls(): void {
  const mode = displayModeControl.value as DisplayMode;
  const maskOnly = mode === 'mask';
  styleControl.disabled = maskOnly;
  levelControl.disabled = maskOnly;
  windowControl.disabled = maskOnly;
  thresholdControl.disabled = maskOnly;
  resetContrastControl.disabled = maskOnly;
  maskOpacityLabel.hidden = mode === 'cbct';
  maskLegend.hidden = mode === 'cbct' || !legendLabels.childElementCount;
}

function renderMaskLegend(labels: number[]): void {
  hiddenLabels.clear();
  legendLabels.replaceChildren(...labels.map(label => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'label-chip';
    chip.dataset.label = String(label);
    chip.setAttribute('aria-pressed', 'true');
    chip.setAttribute('aria-label', `Class ${label}, shown`);
    const swatch = document.createElement('i');
    swatch.style.background = labelColorCss(label);
    chip.append(swatch, document.createTextNode(String(label)));
    chip.addEventListener('click', () => toggleLabel(label));
    return chip;
  }));
  applyHiddenLabels();
  syncMaskControls();
}

/** Toggle one class on/off and keep its legend chip in sync. */
function toggleLabel(label: number): void {
  if (hiddenLabels.has(label)) hiddenLabels.delete(label);
  else hiddenLabels.add(label);
  updateLabelChip(label);
  applyHiddenLabels();
}

function setLabelVisible(label: number, visible: boolean): void {
  if (visible) hiddenLabels.delete(label);
  else hiddenLabels.add(label);
  updateLabelChip(label);
}

function updateLabelChip(label: number): void {
  const chip = legendLabels.querySelector<HTMLElement>(`[data-label="${label}"]`);
  if (!chip) return;
  const visible = !hiddenLabels.has(label);
  chip.setAttribute('aria-pressed', String(visible));
  chip.setAttribute('aria-label', `Class ${label}, ${visible ? 'shown' : 'hidden'}`);
}

function setAllLabelsVisible(visible: boolean): void {
  legendLabels.querySelectorAll<HTMLElement>('.label-chip').forEach(chip => {
    const label = Number(chip.dataset.label);
    if (!Number.isFinite(label)) return;
    setLabelVisible(label, visible);
  });
  applyHiddenLabels();
}

function buildPreviewSize(dimensions: [number, number, number]): number[] {
  return dimensions.map(dimension => Math.ceil(dimension / Math.max(1, Math.ceil(dimension / MAX_TEXTURE_DIMENSION))));
}

function updateWindowFromControls(): void {
  if (!loaded) return;
  const span = loaded.range.max - loaded.range.min || 1;
  level = loaded.range.min + (Number(levelControl.value) / 1000) * span;
  width = Math.max(span / 1000, (Number(windowControl.value) / 1000) * span);
  syncOutputs();
  applyClim();
}

function resetContrast(): void {
  if (!loaded) return;
  level = (loaded.range.low + loaded.range.high) / 2;
  width = Math.max((loaded.range.max - loaded.range.min) / 1000, loaded.range.high - loaded.range.low);
  syncControls();
  applyClim();
}

function syncControls(): void {
  if (!loaded) return;
  const span = loaded.range.max - loaded.range.min || 1;
  levelControl.value = String(Math.round(((level - loaded.range.min) / span) * 1000));
  windowControl.value = String(Math.max(1, Math.round((width / span) * 1000)));
  syncOutputs();
}

function syncOutputs(): void {
  levelOutput.value = formatNumber(level);
  windowOutput.value = formatNumber(width);
}

function applyClim(): void {
  if (!loaded || !volumeView) return;
  const span = loaded.range.max - loaded.range.min || 1;
  let low = THREE.MathUtils.clamp((level - width / 2 - loaded.range.min) / span, 0, 1);
  let high = THREE.MathUtils.clamp((level + width / 2 - loaded.range.min) / span, 0, 1);
  if (high - low < 0.0001) {
    high = Math.min(1, low + 0.0001);
    low = Math.max(0, high - 0.0001);
  }
  volumeView.setClim(low, high);
  drawSlices();
}

function applyHiddenLabels(): void {
  volumeView?.setHiddenLabels(hiddenLabels);
  drawSlices();
}

type SliceGeometry = ReturnType<typeof computeSliceGeometry>;

/** Redraw the three 2D panels on the next frame (coalesced; no-op in the single 3D layout). */
function drawSlices(): void {
  if (!quad || sliceFrame !== undefined) return;
  sliceFrame = requestAnimationFrame(() => {
    sliceFrame = undefined;
    if (!loaded || !volumeView) return;
    sliceGeometry = computeSliceGeometry(loaded, volumeView);
    const mode = displayModeControl.value as DisplayMode;
    const colors = labelPalette();
    for (const label of hiddenLabels) colors[label * 4 + 3] = 0;
    const mask = mode !== 'cbct' && maskSource
      ? { ...maskSource, colors, opacity: Number(maskOpacityControl.value) / 100, only: mode === 'mask' }
      : undefined;
    for (const plane of SLICE_PLANES) drawSlice(plane, sliceGeometry, mask);
  });
}

/** Full-resolution voxel <-> display-world mapping shared with the 3D view (same centring). */
function computeSliceGeometry(volume: LoadedVolume, view: VolumeView) {
  const { presentation, volume: placement } = view.matrices();
  const [nx, ny, nz] = volume.dimensions;
  const voxelToWorld = placement
    .multiply(new THREE.Matrix4().makeScale(...volume.spacing))
    .multiply(new THREE.Matrix4().makeTranslation(-(nx - 1) / 2, -(ny - 1) / 2, -(nz - 1) / 2));
  const bounds = new THREE.Box3();
  for (let corner = 0; corner < 8; corner++) {
    bounds.expandByPoint(new THREE.Vector3(
      corner & 1 ? nx - 0.5 : -0.5,
      corner & 2 ? ny - 0.5 : -0.5,
      corner & 4 ? nz - 0.5 : -0.5,
    ).applyMatrix4(voxelToWorld));
  }
  const e = voxelToWorld.elements;
  const step = [0, 1, 2].map(axis => Math.max(...[0, 1, 2].map(column => Math.abs(e[column * 4 + axis]))));
  const size = bounds.getSize(new THREE.Vector3());
  return {
    presentation,
    worldToVoxel: voxelToWorld.clone().invert().elements,
    min: bounds.min.toArray(),
    max: bounds.max.toArray(),
    step,
    // ponytail: slices capped at 768 px per side so crosshair drags stay interactive.
    pixelSize: Math.max(Math.min(...step), Math.max(size.x, size.y, size.z) / 768),
  };
}

function drawSlice(plane: Plane, geometry: SliceGeometry, mask: Parameters<typeof renderSlice>[5]): void {
  if (!loaded) return;
  const canvas = sliceCanvases[plane];
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
  canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
  const spec = slicePlane(plane, geometry.worldToVoxel, geometry.min, geometry.max, cursor, geometry.pixelSize);
  const image = new ImageData(spec.width, spec.height);
  renderSlice(image.data, spec, loaded, level - width / 2, level + width / 2, mask);
  sliceScratch.width = spec.width;
  sliceScratch.height = spec.height;
  sliceScratch.getContext('2d')?.putImageData(image, 0, 0);
  const context = canvas.getContext('2d');
  if (!context) return;
  const scale = Math.min(canvas.width / spec.width, canvas.height / spec.height);
  const left = (canvas.width - spec.width * scale) / 2;
  const top = (canvas.height - spec.height * scale) / 2;
  context.fillStyle = '#000';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(sliceScratch, left, top, spec.width * scale, spec.height * scale);
  sliceLayouts.set(plane, { spec, scale, left, top });

  const { u, uSign, v, vSign, normal } = SLICE_AXES[plane];
  const x = left + ((cursor[u] - spec.topLeft[u]) / (uSign * spec.pixelSize) + 0.5) * scale;
  const y = top + ((cursor[v] - spec.topLeft[v]) / (vSign * spec.pixelSize) + 0.5) * scale;
  context.lineWidth = dpr;
  context.strokeStyle = PLANE_COLORS[PLANE_WITH_NORMAL[u]];
  context.beginPath();
  context.moveTo(x, top);
  context.lineTo(x, top + spec.height * scale);
  context.stroke();
  context.strokeStyle = PLANE_COLORS[PLANE_WITH_NORMAL[v]];
  context.beginPath();
  context.moveTo(left, y);
  context.lineTo(left + spec.width * scale, y);
  context.stroke();

  const pad = 7 * dpr;
  const p = geometry.presentation;
  context.font = `600 ${11 * dpr}px sans-serif`;
  context.textAlign = 'left';
  context.textBaseline = 'top';
  context.fillStyle = PLANE_COLORS[plane];
  context.fillText(`${plane[0].toUpperCase()}${plane.slice(1)}  ${formatNumber(cursor[normal])} mm`, pad, pad);
  context.fillStyle = 'rgba(245, 249, 252, 0.82)';
  context.textBaseline = 'middle';
  context.fillText(directionLabel(p, u, -uSign), pad, canvas.height / 2);
  context.textAlign = 'right';
  context.fillText(directionLabel(p, u, uSign), canvas.width - pad, canvas.height / 2);
  context.textAlign = 'center';
  context.textBaseline = 'top';
  context.fillText(directionLabel(p, v, -vSign), canvas.width / 2, pad);
  context.textBaseline = 'bottom';
  context.fillText(directionLabel(p, v, vSign), canvas.width / 2, canvas.height - pad);
}

/** Patient direction (R/L, A/P, S/I) of a signed display axis, undoing any axis swap or LAS mirror. */
function directionLabel(presentation: THREE.Matrix4, axis: number, sign: number): string {
  const e = presentation.elements;
  let best = 0;
  for (let column = 1; column < 3; column++) {
    if (Math.abs(e[column * 4 + axis]) > Math.abs(e[best * 4 + axis])) best = column;
  }
  return (e[best * 4 + axis] * sign > 0 ? 'RAS' : 'LPI')[best];
}

function moveCursor(plane: Plane, event: PointerEvent): void {
  const layout = sliceLayouts.get(plane);
  if (!layout) return;
  const { spec, scale, left, top } = layout;
  const { u, uSign, v, vSign } = SLICE_AXES[plane];
  const dpr = window.devicePixelRatio || 1;
  cursor[u] = spec.topLeft[u] + ((event.offsetX * dpr - left) / scale - 0.5) * uSign * spec.pixelSize;
  cursor[v] = spec.topLeft[v] + ((event.offsetY * dpr - top) / scale - 0.5) * vSign * spec.pixelSize;
  clampCursor();
  drawSlices();
}

function clampCursor(): void {
  if (!sliceGeometry) return;
  for (let axis = 0; axis < 3; axis++) {
    cursor[axis] = THREE.MathUtils.clamp(cursor[axis], sliceGeometry.min[axis], sliceGeometry.max[axis]);
  }
}

function createVolumeView(
  container: HTMLElement,
  volume: LoadedVolume,
  preview: VolumeTextureData,
): VolumeView {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setClearColor(0x05080d, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const physical = new THREE.Vector3(
    volume.dimensions[0] * volume.spacing[0],
    volume.dimensions[1] * volume.spacing[1],
    volume.dimensions[2] * volume.spacing[2],
  );
  const frame = Math.max(physical.x, physical.y, physical.z) * 1.35;
  const camera = new THREE.OrthographicCamera(-frame / 2, frame / 2, frame / 2, -frame / 2, 0.01, frame * 10);
  camera.up.set(0, 0, 1);
  const initialPosition = new THREE.Vector3(frame * 0.9, -frame * 0.9, frame * 0.55);
  camera.position.copy(initialPosition);

  // Turntable rotation around the patient's superior axis. Incremental
  // rotations about screen axes (TrackballControls, or rotating the scan per
  // pointer delta) do not commute, so circular drags accumulate a roll opposite
  // to the gesture. OrbitControls derives the view from azimuth/elevation only,
  // so no drift is possible. It reads camera.up once: never change it later.
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = true;
  controls.screenSpacePanning = true;
  controls.minZoom = 0.35;
  controls.maxZoom = 8;
  controls.target.set(0, 0, 0);

  const rampData = new Uint8Array(256 * 4);
  for (let index = 0; index < 256; index += 1) {
    // Neutral grayscale is intentional: it matches the reference CBCT viewer
    // and avoids the muddy orange cast of the previous transfer function.
    rampData[index * 4] = index;
    rampData[index * 4 + 1] = index;
    rampData[index * 4 + 2] = index;
    rampData[index * 4 + 3] = 255;
  }
  const ramp = new THREE.DataTexture(rampData, 256, 1, THREE.RGBAFormat);
  ramp.minFilter = THREE.LinearFilter;
  ramp.magFilter = THREE.LinearFilter;
  ramp.needsUpdate = true;

  const [dx, dy, dz] = preview.dimensions;
  const texture = new THREE.Data3DTexture(preview.data as Uint8Array<ArrayBuffer>, dx, dy, dz);
  texture.format = THREE.RedFormat;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;

  const uniforms = THREE.UniformsUtils.clone(VolumeRenderShader1.uniforms);
  uniforms.u_data.value = texture;
  uniforms.u_size.value.set(dx, dy, dz);
  uniforms.u_clim.value.set(0, 1);
  uniforms.u_renderstyle.value = 2;
  uniforms.u_renderthreshold.value = 0.35;
  uniforms.u_cmdata.value = ramp;

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VolumeRenderShader1.vertexShader,
    fragmentShader: buildVolumeFragmentShader(),
    side: THREE.BackSide,
  });
  const box = new THREE.BoxGeometry(dx, dy, dz);
  box.translate(dx / 2 - 0.5, dy / 2 - 0.5, dz / 2 - 0.5);
  const voxelSize = new THREE.Vector3(physical.x / dx, physical.y / dy, physical.z / dz);
  const mesh = new THREE.Mesh(box, material);
  mesh.scale.copy(voxelSize);
  mesh.position.set(
    (-voxelSize.x * (dx - 1)) / 2,
    (-voxelSize.y * (dy - 1)) / 2,
    (-voxelSize.z * (dz - 1)) / 2,
  );

  const volumeGroup = new THREE.Group();
  const direction = new THREE.Matrix4().fromArray(volume.direction);
  direction.setPosition(0, 0, 0);
  if (volume.upsideDown) direction.premultiply(new THREE.Matrix4().makeScale(1, 1, -1));
  volumeGroup.matrixAutoUpdate = false;
  volumeGroup.matrix.copy(direction);
  volumeGroup.add(mesh);
  const maskPalette = createMaskPalette();
  let maskTexture = createEmptyMaskTexture();
  const maskUniforms = {
    u_size: { value: new THREE.Vector3(dx, dy, dz) },
    u_mask: { value: maskTexture },
    u_palette: { value: maskPalette },
    u_opacity: { value: Number(maskOpacityControl.value) / 100 },
  };
  const maskMaterial = new THREE.ShaderMaterial({
    uniforms: maskUniforms,
    vertexShader: VolumeRenderShader1.vertexShader,
    fragmentShader: buildMaskFragmentShader(),
    side: THREE.BackSide,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const maskMesh = new THREE.Mesh(box, maskMaterial);
  maskMesh.scale.copy(mesh.scale);
  maskMesh.position.copy(mesh.position);
  maskMesh.renderOrder = 1;
  maskMesh.visible = false;
  volumeGroup.add(maskMesh);
  const scene = new THREE.Scene();
  scene.add(volumeGroup);

  let currentAxisOrder: AxisOrder = 'xyz';
  let currentRas = true;
  let currentDisplayMode: DisplayMode = 'cbct';
  let maskAvailable = false;

  let frameHandle: number | undefined;
  let interactionActive = false;
  let destroyed = false;
  const pixelRatio = () => Math.min(window.devicePixelRatio || 1, interactionActive ? 1 : 1.5);
  const syncSize = () => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (!width || !height) return;
    const aspect = width / height;
    camera.left = (-frame * aspect) / 2;
    camera.right = (frame * aspect) / 2;
    camera.top = frame / 2;
    camera.bottom = -frame / 2;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(pixelRatio());
    renderer.setSize(width, height, false);
    requestRender();
  };
  const renderFrame = () => {
    frameHandle = undefined;
    if (destroyed) return;
    const changed = controls.update();
    renderer.render(scene, camera);
    if (interactionActive || changed) requestRender();
  };
  function requestRender(): void {
    if (destroyed || frameHandle !== undefined) return;
    frameHandle = requestAnimationFrame(renderFrame);
  }

  const setInteractive = (active: boolean) => {
    if (interactionActive === active) return;
    interactionActive = active;
    syncSize();
  };
  let presentation = new THREE.Matrix4();
  const applyPresentation = () => {
    presentation = (currentRas ? new THREE.Matrix4() : new THREE.Matrix4().makeScale(-1, 1, 1))
      .multiply(axisOrderMatrix(currentAxisOrder));
    volumeGroup.matrix.copy(presentation).multiply(direction);
    volumeGroup.updateMatrixWorld(true);
    requestRender();
  };
  const updateVisibility = () => {
    mesh.visible = currentDisplayMode !== 'mask';
    maskMesh.visible = maskAvailable && currentDisplayMode !== 'cbct';
    requestRender();
  };

  controls.addEventListener('change', requestRender);
  controls.addEventListener('start', () => setInteractive(true));
  controls.addEventListener('end', () => setInteractive(false));
  const resizeObserver = new ResizeObserver(syncSize);
  resizeObserver.observe(container);
  syncSize();
  controls.update();
  requestRender();

  return {
    setClim: (low, high) => {
      uniforms.u_clim.value.set(low, high);
      requestRender();
    },
    setStyle: (style) => {
      uniforms.u_renderstyle.value = style === 'iso' ? 1 : style === 'amip' ? 2 : 0;
      requestRender();
    },
    setThreshold: (value) => {
      uniforms.u_renderthreshold.value = value;
      requestRender();
    },
    setInteractive,
    setAxisOrder: (order) => {
      currentAxisOrder = order;
      applyPresentation();
    },
    setRas: (value) => {
      currentRas = value;
      applyPresentation();
    },
    setMask: (mask) => {
      if (mask.dimensions[0] !== dx || mask.dimensions[1] !== dy || mask.dimensions[2] !== dz) {
        throw new Error('The prepared mask texture does not align with the CBCT texture.');
      }
      const replacement = new THREE.Data3DTexture(
        mask.data as Uint8Array<ArrayBuffer>,
        mask.dimensions[0],
        mask.dimensions[1],
        mask.dimensions[2],
      );
      replacement.format = THREE.RedFormat;
      replacement.type = THREE.UnsignedByteType;
      replacement.minFilter = THREE.NearestFilter;
      replacement.magFilter = THREE.NearestFilter;
      replacement.unpackAlignment = 1;
      replacement.needsUpdate = true;
      maskTexture.dispose();
      maskTexture = replacement;
      maskUniforms.u_mask.value = replacement;
      maskUniforms.u_size.value.set(...mask.dimensions);
      maskAvailable = true;
      updateVisibility();
    },
    setDisplayMode: (mode) => {
      currentDisplayMode = mode;
      updateVisibility();
    },
    setMaskOpacity: (opacity) => {
      maskUniforms.u_opacity.value = THREE.MathUtils.clamp(opacity, 0, 1);
      requestRender();
    },
    setHiddenLabels: (labels) => {
      const hidden = new Set(labels);
      const data = maskPalette.image.data as Uint8Array;
      for (let label = 1; label < 256; label += 1) {
        data[label * 4 + 3] = hidden.has(label) ? 0 : 255;
      }
      maskPalette.needsUpdate = true;
      requestRender();
    },
    setAxialView: () => {
      camera.position.set(0, frame * 0.001, -frame * 0.9);
      camera.zoom = 1;
      controls.target.set(0, 0, 0);
      camera.updateProjectionMatrix();
      controls.update();
      requestRender();
    },
    resetView: () => {
      camera.position.copy(initialPosition);
      camera.zoom = 1;
      controls.target.set(0, 0, 0);
      camera.updateProjectionMatrix();
      controls.update();
      requestRender();
    },
    matrices: () => ({ presentation: presentation.clone(), volume: volumeGroup.matrix.clone() }),
    requestRender,
    dispose: () => {
      destroyed = true;
      if (frameHandle !== undefined) cancelAnimationFrame(frameHandle);
      resizeObserver.disconnect();
      controls.dispose();
      box.dispose();
      material.dispose();
      maskMaterial.dispose();
      texture.dispose();
      maskTexture.dispose();
      maskPalette.dispose();
      ramp.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

function axisOrderMatrix(order: AxisOrder): THREE.Matrix4 {
  const sourceForOutput = order.split('').map(axis => 'xyz'.indexOf(axis));
  const rows = sourceForOutput.map(source => [0, 1, 2].map(column => Number(column === source)));
  return new THREE.Matrix4().set(
    rows[0][0], rows[0][1], rows[0][2], 0,
    rows[1][0], rows[1][1], rows[1][2], 0,
    rows[2][0], rows[2][1], rows[2][2], 0,
    0, 0, 0, 1,
  );
}

function labelHue(label: number): number {
  return (label * 0.618033988749895) % 1;
}

function labelColorCss(label: number): string {
  return `hsl(${Math.round(labelHue(label) * 360)} 76% 60%)`;
}

function createMaskPalette(): THREE.DataTexture {
  const palette = new THREE.DataTexture(labelPalette(), 256, 1, THREE.RGBAFormat);
  palette.minFilter = THREE.NearestFilter;
  palette.magFilter = THREE.NearestFilter;
  palette.needsUpdate = true;
  return palette;
}

/** RGBA per label (label 0 transparent), matching the legend chips. */
function labelPalette(): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(256 * 4);
  const color = new THREE.Color();
  for (let label = 1; label < 256; label += 1) {
    color.setHSL(labelHue(label), 0.76, 0.60);
    data[label * 4] = Math.round(color.r * 255);
    data[label * 4 + 1] = Math.round(color.g * 255);
    data[label * 4 + 2] = Math.round(color.b * 255);
    data[label * 4 + 3] = 255;
  }
  return data;
}

function createEmptyMaskTexture(): THREE.Data3DTexture {
  const texture = new THREE.Data3DTexture(new Uint8Array(1), 1, 1, 1);
  texture.format = THREE.RedFormat;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

function buildMaskFragmentShader(): string {
  return `
    precision highp float;
    precision mediump sampler3D;

    uniform vec3 u_size;
    uniform sampler3D u_mask;
    uniform sampler2D u_palette;
    uniform float u_opacity;

    varying vec3 v_position;
    varying vec4 v_nearpos;
    varying vec4 v_farpos;

    const int MAX_STEPS = 887;

    float sample_mask(vec3 location) {
      return texture(u_mask, location).r;
    }

    void main() {
      vec3 farpos = v_farpos.xyz / v_farpos.w;
      vec3 nearpos = v_nearpos.xyz / v_nearpos.w;
      vec3 view_ray = normalize(nearpos - farpos);
      float distance = dot(nearpos - v_position, view_ray);
      distance = max(distance, min((-0.5 - v_position.x) / view_ray.x,
                                   (u_size.x - 0.5 - v_position.x) / view_ray.x));
      distance = max(distance, min((-0.5 - v_position.y) / view_ray.y,
                                   (u_size.y - 0.5 - v_position.y) / view_ray.y));
      distance = max(distance, min((-0.5 - v_position.z) / view_ray.z,
                                   (u_size.z - 0.5 - v_position.z) / view_ray.z));
      vec3 front = v_position + view_ray * distance;
      int nsteps = int(-distance + 0.5);
      if (nsteps < 1) discard;
      vec3 step_ray = ((v_position - front) / u_size) / float(nsteps);
      vec3 location = front / u_size;
      vec3 derivative = 1.0 / u_size;

      for (int iter = 0; iter < MAX_STEPS; iter++) {
        if (iter >= nsteps) break;
        float label = sample_mask(location);
        if (label > 0.001) {
          // The palette alpha carries per-class visibility, so a disabled
          // class neither draws nor occludes visible classes behind it.
          vec4 color = texture2D(u_palette, vec2(label, 0.5));
          if (color.a > 0.001) {
            float gx = step(0.001, sample_mask(location - vec3(derivative.x, 0.0, 0.0)))
                     - step(0.001, sample_mask(location + vec3(derivative.x, 0.0, 0.0)));
            float gy = step(0.001, sample_mask(location - vec3(0.0, derivative.y, 0.0)))
                     - step(0.001, sample_mask(location + vec3(0.0, derivative.y, 0.0)));
            float gz = step(0.001, sample_mask(location - vec3(0.0, 0.0, derivative.z)))
                     - step(0.001, sample_mask(location + vec3(0.0, 0.0, derivative.z)));
            vec3 gradient = vec3(gx, gy, gz);
            float shade = 0.88;
            if (length(gradient) > 0.01) {
              shade = 0.68 + 0.32 * abs(dot(normalize(gradient), normalize(view_ray)));
            }
            gl_FragColor = vec4(color.rgb * shade, u_opacity * color.a);
            return;
          }
        }
        location += step_ray;
      }
      discard;
    }
  `;
}

function buildVolumeFragmentShader(): string {
  const attenuatedMip = `
    void cast_amip(vec3 start_loc, vec3 step, int nsteps, vec3 view_ray) {
      float max_val = 0.0;
      float transmittance = 1.0;
      float clim_span = max(u_clim[1] - u_clim[0], 1e-6);
      vec3 loc = start_loc;

      for (int iter = 0; iter < MAX_STEPS; iter++) {
        if (iter >= nsteps) break;
        float val = sample1(loc);
        float density = clamp((val - u_clim[0]) / clim_span, 0.0, 1.0);
        max_val = max(max_val, density * transmittance);
        transmittance *= exp(-density * 0.02);
        if (transmittance < 0.01) break;
        loc += step;
      }
      gl_FragColor = texture2D(u_cmdata, vec2(max_val, 0.5));
    }
  `;
  let shader = VolumeRenderShader1.fragmentShader;
  const edits: Array<[RegExp, string]> = [
    [/(void cast_mip\(vec3 start_loc, vec3 step, int nsteps, vec3 view_ray\);)/,
      '$1\nvoid cast_amip(vec3 start_loc, vec3 step, int nsteps, vec3 view_ray);'],
    [/(else if \(u_renderstyle == 1\)\s+cast_iso\(start_loc, step, nsteps, view_ray\);)/,
      '$1\nelse if (u_renderstyle == 2)\n  cast_amip(start_loc, step, nsteps, view_ray);'],
    [/(\s+void cast_iso\(vec3 start_loc, vec3 step, int nsteps, vec3 view_ray\) \{)/,
      `${attenuatedMip}$1`],
  ];
  for (const [pattern, replacement] of edits) {
    const updated = shader.replace(pattern, replacement);
    if (updated === shader) throw new Error('The GPU volume shader could not be initialized.');
    shader = updated;
  }
  return shader;
}

function formatNumber(value: number): string {
  const absolute = Math.abs(value);
  if ((absolute > 0 && absolute < 0.01) || absolute >= 10_000) return value.toExponential(2);
  return Number(value.toFixed(absolute < 10 ? 2 : absolute < 100 ? 1 : 0)).toLocaleString();
}

function setLoading(message: string): void {
  loadingMessage.textContent = message;
  loading.hidden = false;
}

function showError(error: unknown): void {
  if (disposed) return;
  loading.hidden = true;
  errorBox.hidden = false;
  errorBox.textContent = error instanceof Error ? error.message : String(error);
  console.error(error);
}

function nextFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing viewer element #${id}.`);
  return element as T;
}

window.addEventListener('pagehide', () => {
  disposed = true;
  volumeView?.dispose();
  volumeView = undefined;
  loaded = undefined;
}, { once: true });

syncOrientationControl();
