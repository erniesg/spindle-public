"""Explicit local-only CPU pilot. Never downloads a model or claims portrait quality."""
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

EXPECTED = '07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9'
model = Path(sys.argv[1])
if model.stat().st_size != 25888640 or hashlib.sha256(model.read_bytes()).hexdigest() != EXPECTED:
    raise ValueError('Model integrity failure')
options = ort.SessionOptions()
options.intra_op_num_threads = 1
options.inter_op_num_threads = 1
session = ort.InferenceSession(str(model), sess_options=options, providers=['CPUExecutionProvider'])
print(json.dumps({'providers': session.get_providers(), 'inputs': [(x.name, x.shape) for x in session.get_inputs()]}), flush=True)
for i, (width, height, rotation) in enumerate([(512, 512, 0), (640, 480, 17), (480, 720, 33)]):
    y, x = np.mgrid[:height, :width]
    pixels = np.stack([(x * 255 // width), (y * 255 // height), ((x + y) % 256)], axis=2).astype(np.uint8)
    image = Image.fromarray(pixels).rotate(rotation).convert('RGB')
    scale = min(512 / min(image.size), 1024 / max(image.size))
    size = tuple(max(32, round(v * scale / 32) * 32) for v in image.size)
    tensor = ((np.asarray(image.resize(size, Image.Resampling.BILINEAR), dtype=np.float32) / 255 - 0.5) / 0.5).transpose(2, 0, 1)[None].copy()
    alpha = session.run(None, {session.get_inputs()[0].name: tensor})[0]
    if not np.isfinite(alpha).all():
        raise ValueError('Nonfinite alpha')
    print(json.dumps({'case': i, 'invented_size': image.size, 'rotation': rotation, 'input_shape': tensor.shape, 'output_shape': alpha.shape, 'alpha_min': float(alpha.min()), 'alpha_max': float(alpha.max()), 'alpha_sha256': hashlib.sha256(alpha.tobytes()).hexdigest()}), flush=True)
