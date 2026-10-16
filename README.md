# ToothFairy NIfTI Viewer

A VS Code extension for interactive viewing of CBCT NIfTI volumes and their segmentation masks. It opens `.nii` and `.nii.gz` files as a custom editor with a GPU-rendered 3D view and an optional four-up (axial, coronal, sagittal + 3D) layout. Scans whose headers store superior/inferior upside down, such as the ToothFairy datasets, are corrected automatically.

## Install

Search for **ToothFairy NIfTI Viewer** in the Extensions view, or run `code --install-extension aimagelab.toothfairy-nifti-viewer`. Then open any `.nii` or `.nii.gz` file.

## Rendering modes

- **MIP** — maximum-intensity projection, useful for dense structures.
- **Attenuated MIP** — depth-aware maximum-intensity rendering, matching the LMArena Dental viewer.
- **Isosurface** — a GPU ray-marched surface at the selected intensity.

The controls expose level/window contrast, render style, isosurface threshold, axial view, camera reset, all six display-axis permutations, and a LAS/RAS presentation toggle. Left-drag orbits turntable-style around the patient's superior axis (unlimited horizontally, top-to-bottom vertically), so circular drags never accumulate roll; right-drag pans and the wheel zooms.

**Four-up** switches to the classic four-panel layout: axial, coronal and sagittal slices plus the 3D view. Slices are sampled at full resolution in radiological convention (patient right on screen left, anterior/superior up, sagittal with anterior on the left) and labelled with R/L, A/P, S/I. They follow the same transform as the 3D view, so the S/I auto-flip, LAS/RAS mirror and axis swaps apply to them too. Click or drag in a slice to move the crosshair, and scroll to step one voxel through the slices. Level/window and the mask overlay (classes, opacity, display mode) are shared with the 3D view.

## Segmentation masks

The **Display** control supports CBCT, mask-only, and CBCT + mask overlay modes. Opening a categorical NIfTI label map directly selects mask-only mode automatically. From a CBCT, choose **Load mask…** to select an aligned `.nii` or `.nii.gz` label map and enter overlay mode. Mask opacity remains adjustable in both mask modes.

Labels 1–255 receive deterministic, high-contrast categorical colors. The legend lists every class present in the mask and each chip toggles that class on or off, with **All** and **None** shortcuts for the whole set. Hidden classes neither draw nor occlude visible classes behind them, and visibility resets when a new mask is loaded. Downsampling uses the most frequent non-background class in each block rather than averaging label IDs, and texture sampling is nearest-neighbor. Overlay masks must have the same dimensions, spacing, and spatial transform as the open CBCT; mismatches are rejected instead of being silently misregistered.

NIfTI sform orientation takes precedence, followed by qform and then a pixdim fallback. The selected transform is applied before any optional display-axis swap or LAS/RAS reflection, and its source plus voxel orientation code are shown in the metadata line. Headers whose superior/inferior axis contradicts the anatomy (e.g. ToothFairy3, where every scan is stored upside down) are flipped automatically and marked "S/I auto-flipped": a CBCT's bone-poor end (below the mandible) is taken as inferior, and a label map's FDI upper teeth (11–28) must sit above its lower teeth (31–48). Overlay masks inherit the CBCT's decision. Intensity scaling is also applied by the renderer. Sliders span the full intensity range with percentile-based defaults. For multidimensional files, only the first 3D frame is displayed. A box-filtered 8-bit GPU texture is capped at 256 voxels per axis, so camera movement and every intensity control remain responsive even for full-size CBCT scans. All three styles share one Three.js ray-marching shader; changing modes no longer runs CPU marching cubes or rebuilds geometry.

Run `npm test` for geometry, scaling, and intensity-window regression checks.

## Run locally

```bash
git clone https://github.com/Morelli-01/toothfairy-nifti-viewer
cd toothfairy-nifti-viewer
npm install
npm run build
code .
```

Press **F5** in VS Code to launch an Extension Development Host, then open a `.nii` or `.nii.gz` file.

## Build and install a VSIX

```bash
npm install
npm run package
code --install-extension toothfairy-nifti-viewer-0.1.0.vsix
```

Volume data never leaves your machine: files are read locally and rendered in the VS Code webview with WebGL.
