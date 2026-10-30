"""Fixed bounded pixel operations; no paths, networking, models or credentials."""
import base64
import io
import json
import sys
import warnings
from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 64_000_000  # camera originals (20-61MP); bomb guard stays active
warnings.simplefilter('error', Image.DecompressionBombWarning)
LIMIT = 32 * 1024 * 1024  # matches images.ts MAX (base64 JSON request)

class ParameterError(ValueError):
    """Fixed, caller-actionable parameter messages; safe to return (never decoder/library text)."""

def integer(value, low, high):
    if type(value) is not int or not low <= value <= high:
        raise ParameterError(f'Integer outside bounds [{low},{high}]')
    return value

def box(value, width, height):
    message = f'Expected pixel box [left,top,right,bottom] inside {width}x{height} with right>left and bottom>top (not [x,y,width,height]); got {value if isinstance(value, list) and len(value) <= 4 and all(type(v) is int for v in value) else "invalid"}'
    if not isinstance(value, list) or len(value) != 4:
        raise ParameterError(message)
    x, y, r, b = value
    try:
        integer(x, 0, width - 1); integer(y, 0, height - 1)
        integer(r, x + 1, width); integer(b, y + 1, height)
    except ParameterError:
        raise ParameterError(message) from None
    return x, y, r, b

def region_affine(region, size):
    """Affine [a,b,c,d,e,f] from output-region pixel edges to oriented-source pixels (x=a*u+b*v+c, y=d*u+e*v+f)."""
    import math
    rw, rh = region['rotatedDimensions']; cw, ch = region['cropDimensions']; l, t = region['box'][:2]
    sx, sy = rw / size[0], rh / size[1]
    th = math.radians(region['rotation']); co, si = math.cos(th), math.sin(th)
    return [co * sx, -si * sy, l + cw / 2 - co * rw / 2 + si * rh / 2,
            si * sx, co * sy, t + ch / 2 - si * rw / 2 - co * rh / 2]

def main():
    raw = sys.stdin.buffer.read(LIMIT + 1)
    if len(raw) > LIMIT:
        raise ValueError('Input too large')
    req = json.loads(raw)
    data = base64.b64decode(req['image'], validate=True)
    if len(data) > 24 * 1024 * 1024:
        raise ValueError('Image too large')
    decoder = dict(backend='Pillow', version=Image.__version__)
    if data[4:8] == b'ftyp':
        # Optional reviewed interpreter package; no download, subprocess or provider.
        try:
            import pillow_heif
        except ImportError:
            raise ValueError('HEIF_DECODER_UNAVAILABLE') from None
        if pillow_heif.__version__ != '1.8.1':
            raise ValueError('HEIF_DECODER_VERSION')
        pillow_heif.register_heif_opener(decode_threads=1, thumbnails=False,
                                         depth_images=False, aux_images=False)
        decoder = dict(backend='pillow-heif', version=pillow_heif.__version__,
                       libheif=pillow_heif.libheif_version(), decodeThreads=1,
                       containerTransformsApplied=True, hdrTo8bit=True,
                       geometryBasis='libheif display raster; container rotation/crop applied')
    original = Image.open(io.BytesIO(data))
    # Camera MPO (e.g. Sony/Fujifilm JPEG + embedded preview): frame 0 is the primary JPEG image.
    if original.format == 'MPO':
        original.seek(0)
    elif original.format not in ('PNG', 'JPEG', 'HEIF') or getattr(original, 'n_frames', 1) != 1:
        raise ValueError('Only single-frame PNG/JPEG/HEIF supported')
    # Lazy header inspection precedes pixel allocation. Keep libheif security limits on.
    if not (0 < original.width <= 16384 and 0 < original.height <= 16384) or original.width * original.height > Image.MAX_IMAGE_PIXELS:
        raise ValueError('Too many pixels')
    fmt, mode = ('JPEG' if original.format == 'MPO' else original.format), original.mode
    orientation = original.getexif().get(274, 1)
    original_orientation = original.info.get('original_orientation') or orientation
    if orientation not in range(1, 9):
        raise ValueError('Unsupported orientation')
    header_size = original.size
    original.load()
    if original.size != header_size:
        raise ValueError('Decoder geometry changed')
    image = ImageOps.exif_transpose(original)
    meta = dict(format=fmt, mode=mode, width=image.width, height=image.height,
                encodedDimensions=list(header_size), decodedPixels=image.width * image.height,
                bytes=len(data), exifOrientation=orientation,
                originalOrientation=original_orientation, decoder=decoder,
                alpha='preserved until explicit RGB composition',
                coordinateSpace='exif-oriented-pixels')
    op, p = req['operation'], req['parameters']
    if op == 'inspect':
        return dict(metadata=meta, semanticVision=False)
    if op == 'canonicalize':
        # Memory-only, stripped PNG for the existing TextProvider's actual bounds.
        # White alpha composition is only transport preparation, not photo acceptance.
        import hashlib
        if orientation not in range(1, 9):
            raise ValueError('Unsupported orientation')
        w, h = original.size
        # Affine maps EXIF-oriented continuous pixel edges back to encoded edges.
        transforms = {1: [1,0,0,0,1,0], 2: [-1,0,w,0,1,0],
                      3: [-1,0,w,0,-1,h], 4: [1,0,0,0,-1,h],
                      5: [0,1,0,1,0,0], 6: [0,1,0,-1,0,h],
                      7: [0,-1,w,-1,0,h], 8: [0,-1,w,1,0,0]}
        rgba = image.convert('RGBA')
        rgb = Image.new('RGB', image.size, (255,255,255))
        rgb.paste(rgba, mask=rgba.getchannel('A'))
        canonical = rgb.copy()
        region = None
        if 'box' in p or 'rotation' in p:
            # Zoomed read: crop the full-resolution oriented image, then rotate counter-clockwise by
            # `rotation` degrees (white fill). regionToSource maps output pixels back to oriented pixels.
            import math
            l, t, r, b = box(p.get('box', [0, 0, rgb.width, rgb.height]), rgb.width, rgb.height)
            angle = p.get('rotation', 0)
            crop = rgb.crop((l, t, r, b))
            estimated = None
            if angle == 'auto' or (isinstance(angle, dict) and angle.get('auto')):
                # Projection-profile deskew: the angle whose horizontal ink profile is sharpest has text rows
                # aligned. Resolves orientation modulo 180 degrees; callers retry +180 if the read is empty.
                import numpy as np
                offset = angle.get('offset', 0) if isinstance(angle, dict) else 0
                g = crop.convert('L'); g.thumbnail((600, 600))
                ink = Image.fromarray((np.asarray(g) < np.percentile(np.asarray(g), 25)).astype(np.uint8) * 255)
                def sharpness(a):
                    rows = np.asarray(ink.rotate(a, expand=True, fillcolor=0), dtype=np.float32).sum(axis=1)
                    return float(np.square(np.diff(rows)).sum())
                coarse = max(range(-90, 90, 3), key=sharpness)
                estimated = max([coarse + d / 2 for d in range(-6, 7)], key=sharpness)
                angle = ((estimated + offset + 180) % 360) - 180
            if isinstance(angle, bool) or not isinstance(angle, (int, float)) or not -180 <= angle <= 180:
                raise ParameterError('Expected rotation degrees in [-180,180] or "auto"')
            canonical = crop.rotate(angle, expand=True, resample=Image.Resampling.BICUBIC, fillcolor=(255, 255, 255)) if angle else crop
            region = dict(box=[l, t, r, b], rotation=angle, rotatedDimensions=list(canonical.size), cropDimensions=list(crop.size), **({'estimatedRotation': estimated} if estimated is not None else {}))
        # Provider PNGs are capped at 2MB, which camera photos only fit near ~2k px; start there and
        # skip zlib optimize passes (each costs seconds on 12MP input) so canonicalization fits the 15s bound.
        canonical.thumbnail((2048,2048), Image.Resampling.LANCZOS)
        for _ in range(24):
            output = io.BytesIO(); canonical.save(output, format='PNG')
            encoded = output.getvalue()
            if len(encoded) <= 2_000_000 and canonical.width * canonical.height <= 33_554_432:
                return dict(image=base64.b64encode(encoded).decode('ascii'),
                            originalHash=hashlib.sha256(data).hexdigest(),
                            canonicalHash=hashlib.sha256(encoded).hexdigest(),
                            encodedDimensions=[w,h], orientedDimensions=list(image.size),
                            canonicalDimensions=list(canonical.size), orientation=orientation,
                            originalOrientation=original_orientation, decoder=decoder,
                            canonicalToSource=[image.width/canonical.width,0,0,0,image.height/canonical.height,0],
                            **(dict(region=region, regionDimensions=list(canonical.size), regionToSource=region_affine(region, canonical.size)) if region else {}),
                            sourceToEncoded=transforms[orientation],
                            coordinateSpace='exif-oriented-pixel-edges',
                            preparation='EXIF transpose; RGB white alpha composite; Lanczos downsample; stripped PNG')
            canonical = canonical.resize((max(1,canonical.width*3//4), max(1,canonical.height*3//4)), Image.Resampling.LANCZOS)
        raise ValueError('Cannot fit provider bounds')
    if op == 'form_lines':
        # Deterministic form geometry on a rendered page: long horizontal rules, short vertical dividers,
        # rows of character boxes between two rules, and free underlines (pixels, top-left origin).
        import numpy as np
        dark = np.asarray(image.convert('L')) < 140
        H, W = dark.shape
        def runs(mask_1d, minimum):
            padded = np.concatenate(([0], mask_1d.astype(np.int8), [0])); d = np.diff(padded)
            starts, ends = np.nonzero(d == 1)[0], np.nonzero(d == -1)[0]
            return [(a, b) for a, b in zip(starts, ends) if b - a >= minimum]
        hseg = [(a, b, y) for y in range(H) for a, b in runs(dark[y], max(20, W // 40))]
        hlines = []  # merge consecutive rows of the same rule
        for a, b, y in hseg:
            for line in hlines:
                if abs(line[2] - y) <= 2 and min(b, line[1]) - max(a, line[0]) > 0.8 * min(b - a, line[1] - line[0]):
                    line[0], line[1], line[2] = min(a, line[0]), max(b, line[1]), y; break
            else:
                hlines.append([a, b, y])
        vseg = [(x, a, b) for x in range(W) for a, b in runs(dark[:, x], max(8, H // 120))]
        cells = []; used = set()
        hs = sorted(hlines, key=lambda l: l[2])
        for i, top in enumerate(hs):
            for bottom in hs[i + 1:]:
                gap = bottom[2] - top[2]
                if gap < 8: continue
                if gap > max(60, H // 25): break
                x0, x1 = max(top[0], bottom[0]), min(top[1], bottom[1])
                if x1 - x0 < 10: continue
                xs = sorted({x for x, a, b in vseg if x0 - 2 <= x <= x1 + 2 and a <= top[2] + 3 and b >= bottom[2] - 3})
                merged = []
                for x in xs:
                    if merged and x - merged[-1] <= 2: merged[-1] = x
                    else: merged.append(x)
                row = [[merged[k], top[2], merged[k + 1], bottom[2]] for k in range(len(merged) - 1) if 6 <= merged[k + 1] - merged[k] <= gap * 3]
                if len(row) >= 2:
                    cells.append(row); used.add(id(top)); used.add(id(bottom))
        underlines = [l for l in hlines if id(l) not in used and l[1] - l[0] >= max(40, W // 20)]
        return dict(width=W, height=H, underlines=[[int(a), int(b), int(y)] for a, b, y in underlines], cellRows=[[[int(v) for v in c] for c in row] for row in cells])
    if op == 'verify':
        checks = {k: meta[k] == p[k] for k in ('width', 'height', 'format', 'mode') if k in p}
        if 'maxBytes' in p:
            checks['bytes'] = len(data) < integer(p['maxBytes'], 1, 8 * 1024 * 1024)
        return dict(metadata=meta, checks=checks, passed=all(checks.values()), backgroundVerified=False, visualQualityVerified=False)
    provenance = dict(sourceMetadata=meta)
    image_bounds = None
    if op == 'render_regions':
        # Geometry/text come only from the admitted persisted OCR record in Node.
        # Draw on exact canonical pixels; all legends are separate from the image.
        import math
        from PIL import ImageDraw, ImageFont
        regions = p['regions']
        if not isinstance(regions, list) or not 1 <= len(regions) <= 64 or p['coordinateProvenance'] not in ('model-estimated', 'backend-reported'):
            raise ValueError('Invalid OCR regions')
        footer = 64 + ((len(regions) + 3) // 4) * 20
        width, height = max(800, image.width), image.height + footer
        if width * height > Image.MAX_IMAGE_PIXELS or width > 16384 or height > 16384:
            raise ValueError('OCR preview exceeds bounds')
        canvas = Image.new('RGB', (width, height), 'white')
        canvas.paste(image.convert('RGB'), (0, 0))
        draw = ImageDraw.Draw(canvas)
        font = ImageFont.load_default(size=16)
        for index, region in enumerate(regions):
            polygon = region['polygon']
            if not isinstance(polygon, list) or not 3 <= len(polygon) <= 16 or region['uncertainty'] not in ('unresolved', 'not-assessed'):
                raise ValueError('Invalid OCR region')
            points = []
            for point in polygon:
                x, y = point['x'], point['y']
                if not all(type(n) in (int, float) and math.isfinite(n) and 0 <= n <= 1 for n in (x, y)):
                    raise ValueError('Invalid OCR polygon')
                points.append((x * image.width, y * image.height))
            area = sum(x * points[(i+1) % len(points)][1] - points[(i+1) % len(points)][0] * y for i, (x, y) in enumerate(points))
            if abs(area) < 1e-9:
                raise ValueError('Degenerate OCR region')
            xs, ys = [pt[0] for pt in points], [pt[1] for pt in points]
            bounds = (min(xs), min(ys), max(xs), max(ys))
            draw.rectangle(bounds, outline=(0, 70, 210), width=1)
            draw.line(points + [points[0]], fill=(210, 0, 0), width=3)
            draw.text((bounds[0] + 4, max(0, bounds[1] - 20)), str(index + 1), fill=(180, 0, 0), font=font, stroke_width=1, stroke_fill='white')
            draw.text((8 + (index % 4) * (width // 4), image.height + 60 + (index // 4) * 20), f"{index+1}: {region['uncertainty']}", fill='black', font=font)
        label = 'MODEL-ESTIMATED' if p['coordinateProvenance'] == 'model-estimated' else 'BACKEND-REPORTED'
        draw.text((8, image.height + 4), f'{label} OCR REGIONS - NOT PIXEL ACCURACY / NOT FORM SEMANTICS', fill=(150, 0, 0), font=font)
        draw.text((8, image.height + 26), 'Red: persisted polygon; blue: derived BBOX. Source pixels unchanged below outlines.', fill='black', font=font)
        image_bounds = [0, 0, image.width, image.height]
        output = io.BytesIO(); canvas.save(output, format='PNG')
    elif op == 'text_overlay':
        from PIL import ImageDraw, ImageFont
        text = p['text']
        if not isinstance(text, str) or not 1 <= len(text) <= 128 or any(not 32 <= ord(c) <= 126 for c in text):
            raise ParameterError('Expected literal printable ASCII text')
        x = integer(p['x'], 0, image.width - 1)
        y = integer(p['y'], 0, image.height - 1)
        size = integer(p['fontSize'], 4, 256)
        opacity = integer(p['opacity'], 1, 255)
        stroke = integer(p['strokeWidth'], 0, 16)
        colors = []
        for key in ('colorRGB', 'strokeRGB'):
            rgb = p[key]
            if not isinstance(rgb, list) or len(rgb) != 3:
                raise ParameterError('Expected RGB color')
            colors.append(tuple(integer(v, 0, 255) for v in rgb) + (opacity,))
        font = ImageFont.load_default(size=size)
        layer = Image.new('RGBA', image.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(layer)
        bounds = draw.textbbox((0, 0), text, font=font, stroke_width=stroke)
        width, height = bounds[2] - bounds[0], bounds[3] - bounds[1]
        if width < 1 or height < 1 or x + width > image.width or y + height > image.height:
            raise ParameterError('Text does not fit the image')
        draw.text((x - bounds[0], y - bounds[1]), text, font=font, fill=colors[0],
                  stroke_width=stroke, stroke_fill=colors[1])
        # Keep canonical RGBA: LA/palette/RGB+tRNS inputs also carry alpha.
        image = Image.alpha_composite(image.convert('RGBA'), layer)
        provenance['textOverlay'] = dict(text=text, box=[x, y, width, height],
                                        font='Pillow bundled default', fontSize=size,
                                        opacity=opacity, colorRGB=p['colorRGB'],
                                        strokeRGB=p['strokeRGB'], strokeWidth=stroke,
                                        coordinateSpace='exif-oriented-pixels')
        output = io.BytesIO(); image.save(output, format='PNG')
    elif op == 'remove_background':
        import hashlib
        # Full-resolution camera photos (24+ MP) made matting peak above 4 GB. The model sees 1024 px anyway and
        # ID-photo outputs are a few hundred pixels, so matte a copy whose long edge is at most 2048 px.
        if max(image.size) > 2048:
            scale = 2048 / max(image.size)
            original = list(image.size)
            image = image.resize((max(1, round(image.width * scale)), max(1, round(image.height * scale))), Image.Resampling.LANCZOS)
            provenance['matteInputDownscaled'] = dict(fromSize=original, toSize=list(image.size))
        import numpy as np
        import onnxruntime as ort
        if ort.__version__ != '1.22.1' or np.__version__ != '2.2.6':
            raise ValueError('Pinned runtime required')
        # Read the exact verified bytes once: session never reopens a model path.
        with open(sys.argv[1], 'rb') as model_file:
            model = model_file.read(224005089)
        digest = hashlib.sha256(model).hexdigest()
        # Exactly pinned matting models (size + SHA-256); anything else fails closed.
        pinned = {('07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9', 25888640): 'modnet',
                  ('5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333', 224005088): 'birefnet-general-lite'}
        backend = pinned.get((digest, len(model)))
        if backend is None:
            raise ValueError('Model integrity failure')
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1 if backend == 'modnet' else 4
        options.inter_op_num_threads = 1
        if backend != 'modnet':  # ~0.7GB lower peak for the 1024px Swin model, ~5s slower
            options.enable_cpu_mem_arena = False; options.enable_mem_pattern = False
        session = ort.InferenceSession(model, sess_options=options, providers=['CPUExecutionProvider'])
        if backend == 'modnet':
            scale = min(512 / min(image.size), 1024 / max(image.size))
            size = tuple(max(32, round(v * scale / 32) * 32) for v in image.size)
            tensor = (np.asarray(image.convert('RGB').resize(size, Image.Resampling.BILINEAR), dtype=np.float32) / 127.5 - 1).transpose(2, 0, 1)[None].copy()
            normalization, resize_rule = 'RGB / 127.5 - 1', 'bilinear, short edge 512, long edge <=1024, divisible by 32'
        else:
            # BiRefNet (MIT): fixed 1024x1024 ImageNet-normalised input, sigmoid logits.
            size = (1024, 1024)
            tensor = ((np.asarray(image.convert('RGB').resize(size, Image.Resampling.BILINEAR), dtype=np.float32) / 255 - np.array([0.485, 0.456, 0.406], dtype=np.float32)) / np.array([0.229, 0.224, 0.225], dtype=np.float32)).transpose(2, 0, 1)[None].astype(np.float32).copy()
            normalization, resize_rule = 'ImageNet mean/std', 'bilinear 1024x1024'
        alpha = session.run(None, {session.get_inputs()[0].name: tensor})[0]
        if alpha.shape != (1, 1, size[1], size[0]) or not np.isfinite(alpha).all():
            raise ValueError('Invalid alpha tensor')
        raw_range = [float(alpha.min()), float(alpha.max())]
        if backend != 'modnet':
            alpha = 1 / (1 + np.exp(-alpha)); alpha = (alpha - alpha.min()) / max(float(alpha.max() - alpha.min()), 1e-8)
        mask = Image.fromarray(alpha[0, 0].astype(np.float32)).resize(image.size, Image.Resampling.BILINEAR)
        rgba = image.convert('RGBA')
        alpha_map = np.clip(np.asarray(mask), 0, 1)
        # Tighten the low-resolution matte: faint (<25%) predictions are background leaks (e.g. wall scraps
        # beside the head), strong (>85%) ones are solid subject; smooth ramp in between keeps hair edges.
        alpha_map = np.clip((alpha_map - 0.25) / 0.6, 0, 1); alpha_map = alpha_map * alpha_map * (3 - 2 * alpha_map)
        # Keep only the main subject: drop small disconnected matte fragments (e.g. coloured background blobs).
        grid = Image.fromarray((alpha_map * 255).astype(np.uint8)); grid.thumbnail((256, 256))
        fg = np.asarray(grid) > 127
        labels = np.zeros(fg.shape, dtype=np.int32); sizes = [0]
        for y0, x0 in zip(*np.nonzero(fg)):
            if labels[y0, x0]:
                continue
            sizes.append(0); n = len(sizes) - 1; stack = [(y0, x0)]; labels[y0, x0] = n
            while stack:
                y, x = stack.pop(); sizes[n] += 1
                for yy, xx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                    if 0 <= yy < fg.shape[0] and 0 <= xx < fg.shape[1] and fg[yy, xx] and not labels[yy, xx]:
                        labels[yy, xx] = n; stack.append((yy, xx))
        dropped = 0
        if len(sizes) > 2:
            keep = Image.fromarray(((labels == int(np.argmax(sizes))) * 255).astype(np.uint8)).resize(image.size, Image.Resampling.NEAREST)
            from PIL import ImageFilter
            keep = keep.filter(ImageFilter.MaxFilter(9))  # small dilation so hair edges are not clipped
            alpha_map = alpha_map * (np.asarray(keep, dtype=np.float32) / 255)
            dropped = len(sizes) - 2
        combined = alpha_map * np.asarray(rgba.getchannel('A'), dtype=np.float32)
        # Decontaminate edge colour: a semi-transparent pixel is fg*a + bg*(1-a); estimate the local background
        # from nearby clear-background pixels and remove its share so edges do not keep a wall-coloured fringe.
        from PIL import ImageFilter
        a_n = (combined / 255.0).astype(np.float32)
        rgb_arr = np.asarray(rgba.convert('RGB'), dtype=np.uint8).copy()
        edge_rows, edge_cols = np.nonzero((a_n > 0.02) & (a_n < 0.98))
        if edge_rows.size:
            # Work only on the padded bounding box of the soft edge to bound memory on camera-size inputs.
            pad = 64
            T0, B0 = max(0, int(edge_rows.min()) - pad), min(image.height, int(edge_rows.max()) + pad + 1)
            L0, R0 = max(0, int(edge_cols.min()) - pad), min(image.width, int(edge_cols.max()) + pad + 1)
            a_r = a_n[T0:B0, L0:R0]; c_r = rgb_arr[T0:B0, L0:R0].astype(np.float32)
            small = (max(1, (R0 - L0) // 8), max(1, (B0 - T0) // 8)); full = (R0 - L0, B0 - T0)
            def blur(arr):
                low = np.asarray(Image.fromarray(arr.astype(np.float32)).resize(small, Image.Resampling.BOX), dtype=np.float32)
                for _ in range(3):  # separable box blur on the downscaled grid ~ Gaussian
                    padded = np.pad(low, 4, mode='edge'); low = sum(padded[i:i + low.shape[0], 4:-4] for i in range(9)) / 9
                    padded = np.pad(low, 4, mode='edge'); low = sum(padded[4:-4, i:i + low.shape[1]] for i in range(9)) / 9
                return np.asarray(Image.fromarray(low.astype(np.float32)).resize(full, Image.Resampling.BILINEAR), dtype=np.float32)
            bg_weight = (a_r < 0.05).astype(np.float32)
            weight = blur(bg_weight) + 1e-4
            edge = (a_r > 0.02) & (a_r < 0.98)
            for ch in range(3):
                local_bg = blur(c_r[..., ch] * bg_weight) / weight
                fg = (c_r[..., ch] - (1 - a_r) * local_bg) / np.maximum(a_r, 0.15)
                c_r[..., ch][edge] = np.clip(fg[edge], 0, 255)
            rgb_arr[T0:B0, L0:R0] = np.rint(c_r).astype(np.uint8)
        rgba = Image.fromarray(np.rint(rgb_arr).astype(np.uint8), 'RGB').convert('RGBA')
        rgba.putalpha(Image.fromarray(np.rint(combined).astype(np.uint8)))
        # Full-resolution camera cut-outs exceed the 8MiB output bound as RGBA PNG; downscale until it fits
        # and report the scale (output metadata carries the new pixel dimensions for later crops).
        output_scale = 1.0
        for _ in range(12):
            output = io.BytesIO(); rgba.save(output, format='PNG')
            if len(output.getvalue()) <= 8 * 1024 * 1024:
                break
            rgba = rgba.resize((max(1, rgba.width * 3 // 4), max(1, rgba.height * 3 // 4)), Image.Resampling.LANCZOS)
            output_scale *= 0.75
        image = rgba
        provenance = dict(provenance, sourceMetadata=meta, outputScale=output_scale, inference=dict(model=backend, modelSHA256=digest, runtime=ort.__version__, provider='CPUExecutionProvider', threads=options.intra_op_num_threads, inputSize=size, alphaShape=list(alpha.shape), rawAlphaRange=raw_range, normalization=normalization, resize=resize_rule, alphaComposition='clamp [0,1], tighten 0.25-0.85 smoothstep, keep largest connected subject, multiply original alpha, decontaminate edge colour, round to uint8', droppedFragments=dropped))
    elif op == 'retouch':
        # Only pixels inside the mask rectangle change; outside pixels are unchanged.
        image = image.convert('RGBA')
        target = box(p['mask'], image.width, image.height)
        w, h = target[2] - target[0], target[3] - target[1]
        if w * h > image.width * image.height * 0.1:
            raise ParameterError('Retouch mask exceeds ten percent of the image; use a tighter box around the blemish')
        if 'cloneFrom' in p:
            # Clone mode: copy an equal-size patch of clean texture from outside the mask.
            if not isinstance(p['cloneFrom'], list) or len(p['cloneFrom']) != 2:
                raise ParameterError('Expected cloneFrom [left,top]')
            sx, sy = p['cloneFrom']
            integer(sx, 0, image.width - w); integer(sy, 0, image.height - h)
            if sx < target[2] and sx + w > target[0] and sy < target[3] and sy + h > target[1]:
                raise ParameterError('cloneFrom patch overlaps the mask, so it would copy the blemish; pick clean skin outside the box or omit cloneFrom to inpaint')
            # Healing clone: match the source patch's colour/brightness to the ring around the target, then
            # feather its edges so lighting differences do not leave a visible seam.
            import numpy as np
            arr = np.asarray(image, dtype=np.float32).copy()
            patch = arr[sy:sy + h, sx:sx + w].copy()
            l, t, r, b = target; ring = 4
            L, T, R, B = max(0, l - ring), max(0, t - ring), min(image.width, r + ring), min(image.height, b + ring)
            around = arr[T:B, L:R]; inner = np.zeros(around.shape[:2], dtype=bool); inner[t - T:b - T, l - L:r - L] = True
            ref = around[~inner][:, :3]
            if ref.size:
                pm, ps = patch[..., :3].reshape(-1, 3).mean(0), patch[..., :3].reshape(-1, 3).std(0) + 1e-3
                rm, rs = ref.mean(0), ref.std(0) + 1e-3
                patch[..., :3] = (patch[..., :3] - pm) * np.clip(rs / ps, 0.5, 2.0) + rm
            fy = np.minimum(np.arange(h), np.arange(h)[::-1]) + 1; fx = np.minimum(np.arange(w), np.arange(w)[::-1]) + 1
            edge = max(2, min(w, h) // 6)
            weight = np.clip(np.minimum.outer(fy, fx) / edge, 0, 1)[..., None]
            arr[t:b, l:r] = patch * weight + arr[t:b, l:r] * (1 - weight)
            image = Image.fromarray(np.clip(np.rint(arr), 0, 255).astype(np.uint8), 'RGBA')
            provenance['retouch'] = dict(mode='healing-clone', box=[l, t, r, b], cloneFrom=[sx, sy])
        else:
            # Inpaint mode. Vision boxes are approximate, so by default ('spot') search a wider area for
            # small marks that are redder than the surrounding skin but not much darker (excludes nostrils,
            # eyes, lips, hair shadows), and replace only those pixels. 'box' fills the whole box explicitly.
            import numpy as np
            from PIL import ImageFilter
            fill = p.get('fill', 'spot')
            if fill not in ('spot', 'box'):
                raise ParameterError("Expected fill 'spot' (default) or 'box'")
            l, t, r, b = target
            arr = np.asarray(image, dtype=np.float32).copy()
            mx, my = max(8, w // 2), max(8, h // 2)
            L, T, R, B = max(0, l - mx), max(0, t - my), min(image.width, r + mx), min(image.height, b + my)
            region = arr[T:B, L:R]
            inside = np.zeros(region.shape[:2], dtype=bool)
            if fill == 'box':
                inside[t - T:b - T, l - L:r - L] = True
            else:
                rgb = region[..., :3]
                red = rgb[..., 0] - (rgb[..., 1] + rgb[..., 2]) / 2
                lum = rgb @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
                skin = region[..., 3] > 200 if region.shape[2] == 4 else np.ones(red.shape, dtype=bool)
                med_r, med_l = float(np.median(red[skin])), float(np.median(lum[skin]))
                mad_r = float(np.median(np.abs(red[skin] - med_r))) + 1e-3
                candidate = skin & (red - med_r > max(5.0, 2.5 * mad_r)) & (lum > med_l - 45) & (lum < med_l + 30)
                # Keep small marks only (blemish-sized connected components).
                labels = np.zeros(candidate.shape, dtype=np.int32); sizes = [0]
                for y0, x0 in zip(*np.nonzero(candidate)):
                    if labels[y0, x0]:
                        continue
                    sizes.append(0); n = len(sizes) - 1; stack = [(y0, x0)]; labels[y0, x0] = n
                    while stack:
                        y, x = stack.pop(); sizes[n] += 1
                        for yy, xx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                            if 0 <= yy < candidate.shape[0] and 0 <= xx < candidate.shape[1] and candidate[yy, xx] and not labels[yy, xx]:
                                labels[yy, xx] = n; stack.append((yy, xx))
                limit = max(30, int(0.02 * candidate.size))
                keep = [i for i, size in enumerate(sizes) if i and 4 <= size <= limit]
                spot = np.isin(labels, keep)
                if not spot.any():
                    raise ParameterError('No blemish-like mark found in or near the mask; nothing changed. Re-inspect for a tighter box or use fill "box" deliberately')
                inside = np.asarray(Image.fromarray((spot * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(7))) > 0
            border = region[~inside]
            region[inside] = border.mean(axis=0) if border.size else region[inside]
            for _ in range(200 if fill == 'spot' else min(600, 3 * max(w, h))):
                padded = np.pad(region, ((1, 1), (1, 1), (0, 0)), mode='edge')
                avg = (padded[:-2, 1:-1] + padded[2:, 1:-1] + padded[1:-1, :-2] + padded[1:-1, 2:]) / 4
                region[inside] = avg[inside]
            # Restore natural texture on the replaced pixels from a nearby clean, similar patch.
            rh, rw = region.shape[:2]
            candidates = [(L - rw, T), (R, T), (L, T - rh), (L, B)]
            best = None
            for cx, cy in candidates:
                if 0 <= cx and 0 <= cy and cx + rw <= image.width and cy + rh <= image.height:
                    patch = arr[cy:cy + rh, cx:cx + rw, :3]
                    score = float(np.abs(patch.mean(axis=(0, 1)) - region[..., :3][~inside].mean(axis=0)).sum()) if (~inside).any() else 0.0
                    if best is None or score < best[0]:
                        best = (score, cx, cy)
            texture_from = None
            if best is not None:
                _, cx, cy = best
                src = image.crop((cx, cy, cx + rw, cy + rh)).convert('RGB')
                detail = np.asarray(src, dtype=np.float32) - np.asarray(src.filter(ImageFilter.GaussianBlur(3)), dtype=np.float32)
                view = region[..., :3]; view[inside] += detail[inside]
                texture_from = [cx, cy]
            arr[T:B, L:R] = region
            image = Image.fromarray(np.clip(np.rint(arr), 0, 255).astype(np.uint8), 'RGBA')
            provenance['retouch'] = dict(mode='inpaint-' + fill, box=[l, t, r, b], searchBox=[L, T, R, B], changedPixels=int(inside.sum()), textureFrom=texture_from)
        output = io.BytesIO(); image.save(output, format='PNG')
    elif op == 'fit_photo':
        # Deterministic application-photo framing: the vision model supplies the face box; code places the
        # head at the requested proportion and produces the exact output size on a flat background.
        import numpy as np
        W = integer(p['width'], 64, 4096); H = integer(p['height'], 64, 4096)
        fl, ft, fr, fb = box(p['faceBox'], image.width, image.height)
        head = integer(p.get('headHeight', 70), 30, 90) / 100; top_margin = integer(p.get('topMargin', 10), 0, 40) / 100
        rgb = p.get('backgroundRGB', [255, 255, 255])
        if not isinstance(rgb, list) or len(rgb) != 3:
            raise ParameterError('Expected RGB composition color')
        for v in rgb:
            integer(v, 0, 255)
        rgba = image.convert('RGBA'); alpha = np.asarray(rgba.getchannel('A'))
        face_h = fb - ft
        transparent = bool(alpha.min() < 250)
        # Top of hair = first matte row within the face's columns (vision face boxes may or may not include hair).
        rows = np.nonzero((alpha[:fb, fl:fr] > 128).mean(axis=1) > 0.02)[0] if transparent else np.array([])
        head_top, basis = (int(rows.min()), 'matte') if rows.size else (max(0, ft - int(0.3 * face_h)), 'face-box-estimate')
        head_px = fb - head_top
        if head_px <= 0:
            raise ParameterError('faceBox must run from forehead to chin inside the image')
        scale = head * H / head_px
        win_w, win_h = W / scale, H / scale
        x0 = (fl + fr) / 2 - win_w / 2; y0 = head_top - top_margin * H / scale
        window = [round(x0), round(y0), round(x0 + win_w), round(y0 + win_h)]
        padded = window[0] < 0 or window[1] < 0 or window[2] > image.width or window[3] > image.height
        framed = rgba.crop(tuple(window)).resize((W, H), Image.Resampling.LANCZOS)
        image = Image.new('RGB', (W, H), tuple(rgb)); image.paste(framed, mask=framed.getchannel('A'))
        fmt = p.get('format', 'JPEG')
        if fmt not in ('JPEG', 'PNG'):
            raise ParameterError('Expected format JPEG or PNG')
        max_bytes = integer(p.get('maxBytes', 8 * 1024 * 1024), 1, 8 * 1024 * 1024)
        for q in (sorted(set(range(integer(p.get('quality', 92), 1, 95), 0, -5)) | {1}, reverse=True) if fmt == 'JPEG' else [0]):
            output = io.BytesIO(); image.save(output, format=fmt, **(dict(quality=q, optimize=True) if fmt == 'JPEG' else {}))
            if len(output.getvalue()) <= max_bytes:
                break
        else:
            raise ParameterError(f'Cannot meet byte limit {max_bytes} at {W}x{H} {fmt}; use JPEG or a smaller size')
        provenance['fitPhoto'] = dict(outputSize=[W, H], headTop=head_top, headTopBasis=basis, chin=fb, headHeightPx=head_px,
                                      achievedHeadHeightPercent=round(100 * head_px * scale / H, 1), topMarginPercent=round(100 * top_margin, 1),
                                      sourceWindow=window, paddedWithBackground=padded, backgroundRemovedInput=transparent)
    elif op == 'crop_resize':
        region = box(p['crop'], image.width, image.height)
        w = integer(p['width'], 1, 4096); h = integer(p['height'], 1, 4096)
        if w * h > Image.MAX_IMAGE_PIXELS:
            raise ParameterError('Output too large')
        rgb = p['backgroundRGB']
        if not isinstance(rgb, list) or len(rgb) != 3:
            raise ParameterError('Expected RGB composition color')
        for v in rgb:
            integer(v, 0, 255)
        image = image.convert('RGBA').crop(region).resize((w, h), Image.Resampling.LANCZOS)
        background = Image.new('RGB', image.size, tuple(rgb)); background.paste(image, mask=image.getchannel('A'))
        max_bytes = integer(p['maxBytes'], 1, 8 * 1024 * 1024)
        quality = integer(p['quality'], 1, 95)
        # Include the allowed floor even when the five-point ladder misses it.
        # PNG ignores quality, so encode it only once.
        qualities = sorted(set(range(quality, 0, -5)) | {1}, reverse=True) if p.get('format', 'JPEG') == 'JPEG' else [quality]
        for q in qualities:
            output = io.BytesIO(); background.save(output, format=p.get('format', 'JPEG'), quality=q, optimize=True)
            if len(output.getvalue()) < max_bytes:
                break
        else:
            raise ParameterError(f'Cannot meet byte limit {max_bytes} at {w}x{h} {p.get("format", "JPEG")}; use format JPEG, a lower quality or a smaller width/height (PNG ignores quality)')
    else:
        raise ValueError('Unsupported operation')
    encoded = output.getvalue()
    if len(encoded) > 8 * 1024 * 1024:
        raise ParameterError(f'Output {image.width}x{image.height} exceeds the 8MiB image bound; crop/resize the photo first (e.g. image.crop_resize to the final framing), then apply this operation')
    decoded = Image.open(io.BytesIO(encoded)); decoded.load()
    return dict(**provenance, **(dict(imageBounds=image_bounds) if image_bounds is not None else {}), metadata=dict(format=decoded.format, mode=decoded.mode, width=decoded.width,
                              height=decoded.height, bytes=len(encoded)), image=base64.b64encode(encoded).decode('ascii'))

try:
    result = main()
    sys.stdout.write(json.dumps(result, separators=(',', ':')))
except Exception as error:
    code = str(error) if str(error) in ('HEIF_DECODER_UNAVAILABLE', 'HEIF_DECODER_VERSION') else 'IMAGE_PARAMETERS_INVALID' if isinstance(error, ParameterError) else 'IMAGE_OPERATION_UNAVAILABLE'
    sys.stdout.write(json.dumps(dict(error=code, **(dict(detail=str(error)[:300]) if isinstance(error, ParameterError) else {}))))
    sys.exit(1)
