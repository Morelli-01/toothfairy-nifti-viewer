# Changelog

## 0.3.0

- Controls panel: drag its header to move it off the scan; ▸/▾ folds it down to the header row. It stays inside the view when resized; in four-up it remains the top bar and folding frees room for the slices.

## 0.2.0

- Orientation menu: header transform, raw voxel grid, or any of the 48 standard codes (RAS, LAS, LPS, LPI, …) assigned to the voxel axes. Replaces the automatic S/I flip (which turned ToothFairy3's LPS headers into LPI, a left/right mirror; their anatomy is RPI), the axis-swap menu and the LAS/RAS mirror.
- Image origin marker: voxel (0,0,0) with i/j/k arrows in 3D, a ring in each slice, and its world position in the metadata line.
- The LAS/RAS toggle is gone: slices stay radiological and the 3D view is never mirrored.
- Labels panel: full-height searchable sidebar with class names (from `dataset.json`, else built-in ToothFairy names), show/hide/invert on filtered rows, per-class "Only", collapse.
- Classes that vanish when downsampling the 3D texture are still listed and toggleable.

## 0.1.1

- Marketplace icon and README screenshot.

## 0.1.0

- Initial release: 3D and four-up viewer for `.nii` / `.nii.gz` CBCT volumes and segmentation masks, with automatic S/I correction for ToothFairy scans.
