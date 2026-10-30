# Explicit local CPU matting tool (partial #46)

No runtime auto-download. Model and virtual environment are ignored, under `.local/retained-pr46/`. `uv.lock` pins dependency artifacts; Python 3.12, wheel-only installation (`UV_PYTHON_DOWNLOADS=never uv sync --locked --no-build`). No Node dependency changes.

## Model provenance

- MODNet upstream code/models: Apache-2.0, https://github.com/ZHKKKe/MODNet/tree/28165a451e4610c9d77cfdf925a94610bb2810fb (no GIF reused).
- ONNX conversion/model card: https://huggingface.co/Xenova/modnet/tree/fa2fa546052fba4c08921230a26cc69a333fca12 (Apache-2.0).
- Exact public file: https://huggingface.co/Xenova/modnet/resolve/fa2fa546052fba4c08921230a26cc69a333fca12/onnx/model.onnx
- Bytes: 25888640. SHA-256: `07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9`.
- Apache license: https://www.apache.org/licenses/LICENSE-2.0 . Preserve upstream attribution/license when packaging; this change does not distribute model binaries.

## Python dependency metadata

Official version metadata inspected at `https://pypi.org/pypi/NAME/VERSION/json`:
- NumPy 2.2.6: BSD-3-Clause core; bundled components have additional notices. https://github.com/numpy/numpy/blob/v2.2.6/LICENSE.txt
- ONNX Runtime 1.22.1: MIT. https://github.com/microsoft/onnxruntime/blob/v1.22.1/LICENSE
- Pillow 12.3.0: current PyPI metadata says **MIT-CMU**, not assumed historic HPND. https://pypi.org/project/pillow/12.3.0/ . Installed wheel license/third-party notices remain in the owned venv.

Transitive packages and wheel hashes are locked by uv; packaging/distribution requires retaining their installed license notices too. No redistribution or publication is performed here.

## Observed pilot and limits

`pilot_matting.py` requires an explicit local model path and verifies bytes/hash before loading. CPUExecutionProvider only, intra/inter-op threads both one. RGB normalized `(x/255 - .5)/.5`; aspect-preserving short edge 512 capped at long edge 1024, rounded to multiples of 32. Three invented gradient/rotation cases ran sequentially under a 45-second process timeout. Actual raw alpha contains minor floating-point overshoot (~1e-7); integration must clamp only at compositing, not misreport raw measurements.

Evidence: `.local/retained-pr46/matting-pilot.jsonl` and `matting-tests.log`. `createImageTools(store, {pythonExecutable, modelPath})` now exposes `image.remove_background`; model path is trusted factory configuration, never tool arguments. Missing configuration returns `needs_input`. The bounded fixed worker reads and hashes model bytes once and supplies those exact bytes to ORT. It returns one RGBA PNG with the matte in alpha (multiplied by original alpha). Source/orientation, model hash, raw alpha range, inference shape and transform details travel in ToolResult data for durable runtime observation; there is no sidecar publication. `crop_resize` accepts optional `format: JPEG | PNG`, default JPEG, and composites onto its explicit RGB color.

Actual tool tests exercise invented source -> matting -> 400x514 RGB JPEG under 250000 bytes, changed 240x320 PNG, wrong model hash and in-flight cancellation. This proves CPU machinery, NOT portrait semantics, hair quality, white-background/photo acceptance, Windows or full #46. Existing vision-backed verification and authorised-photo quality evidence remain pending. No new independent review or merge in this phase.
