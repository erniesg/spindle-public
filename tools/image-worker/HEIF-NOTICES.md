# Optional local HEIF decoder

The existing credential-free image worker uses Pillow and, for HEIF containers only,
`pillow-heif==1.8.1`. It never installs packages or downloads models. Supply the
trusted interpreter through `pythonExecutable` to both image and OCR factories.
Missing/wrong decoder versions fail with a configuration error before provider use.

## Reviewed dependency

Reviewed upstream PyPI release metadata, wheel METADATA/licenses, and plugin,
orientation, encoder and lazy-load code on 2026-10-27. The wrapper requires only
Pillow>=11.1.0 at runtime; the configured host already had Pillow12.3.0. Upstream
metadata reported no listed vulnerabilities at inspection time; that is not a
security audit. No upstream decoder implementation was copied.

- [Release](https://pypi.org/project/pillow-heif/1.8.1/)
- [Source](https://github.com/bigcat88/pillow_heif/tree/v1.8.1)
- Reviewed wheel: `pillow_heif-1.8.1-cp312-cp312-manylinux_2_26_aarch64.manylinux_2_28_aarch64.whl`
- Size: 6,418,283 bytes; SHA256: `a36caeeb3e3ce12a3492aa8ab52d08393601303fa9b8b1bb807bef32b1edb505`
- Actual backend: pillow-heif1.8.1 / libheif1.23.6, one decode thread.
- Wrapper: BSD-3-Clause, copyright 2021–2023 Pillow-Heif contributors.
- Upstream wheel notice declares **GPLv2 binary wheels**, bundling libheif1.23.6
  (LGPLv3), libde2651.1.3 (LGPLv3) and x2654.3 (GPLv2). See upstream
  `LICENSE.txt` / `LICENSES_bundled.txt`. Local-only use here: no binaries are
  committed, shipped or uploaded; redistribution needs a separate license review.

## Minimal configured environment

Use an already reviewed CPython3.12/Pillow interpreter. The observed host uses
`/usr/bin/python3` and system-site Pillow. Keep the venv in an ignored owned task
directory and use the shared uv cache:

```sh
uv venv --python /usr/bin/python3 --system-site-packages .local/heif-venv
uv pip install --python .local/heif-venv/bin/python --only-binary=:all: \
  --no-deps --require-hashes -r tools/image-worker/requirements-heif-linux-aarch64.txt
```

This hash selects the reviewed Linux aarch64 wheel only; other platforms need
their own reviewed binary/hash. Do not drop binary/hash/no-deps flags to work
around incompatibility. This optional file does not replace the existing pinned
matting environment or select a second image engine.

## Decode/geometry contract

Single-frame HEIF/HEIC is decoded to real pixels through the same worker and tools
as PNG/JPEG. Keep libheif security limits enabled; disable thumbnail/depth/auxiliary
decoding. Inspect lazy dimensions before allocation, bound encoded bytes to8MiB,
decoded pixels to16MP and dimensions to16,384; terminate workers after15s. This is
not an OS memory sandbox. Multi-image containers and malformed data fail without
publication. HDR is explicitly converted to8bit by the Pillow plugin.

libheif applies container crop/rotation. The plugin resets EXIF orientation and
reports `original_orientation`; do not apply that historical tag a second time.
HEIF geometry is explicitly relative to the **libheif display raster**, not raw
coded tiles. PNG/JPEG geometry retains encoded-pixel-edge coordinates. Metadata
records that distinction, decoded/encoded dimensions, original/remaining EXIF
orientation and decoder identity. Canonical OCR PNGs are ephemeral, stripped and
white-alpha-composited; generated image artifacts retain source hash/parameters
and never overwrite originals.

Tests create actual HEIF bytes, not renamed PNGs: alpha, two changed output
formats/sizes, container rotation, original retention, malformed/multiframe denial,
missing decoder, derived citation and original-HEIF OCR (scripted HTTP only).
They are local pixel/contract proof, not native capture, photo quality or live
model accuracy acceptance.
