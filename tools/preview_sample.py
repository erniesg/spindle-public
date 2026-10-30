"""Invented INPUT image documents for ordinary-app testing, not captured evidence."""
import struct
import zlib

# Small built-in bitmap alphabet; no fonts, downloads or native rendering dependency.
GLYPHS = {
    'A': ['01110','10001','10001','11111','10001','10001','10001'],
    'B': ['11110','10001','10001','11110','10001','10001','11110'],
    'D': ['11110','10001','10001','10001','10001','10001','11110'],
    'E': ['11111','10000','10000','11110','10000','10000','11111'],
    'G': ['01110','10001','10000','10111','10001','10001','01110'],
    'I': ['11111','00100','00100','00100','00100','00100','11111'],
    'L': ['10000','10000','10000','10000','10000','10000','11111'],
    'M': ['10001','11011','10101','10101','10001','10001','10001'],
    'N': ['10001','11001','10101','10011','10001','10001','10001'],
    'O': ['01110','10001','10001','10001','10001','10001','01110'],
    'P': ['11110','10001','10001','11110','10000','10000','10000'],
    'R': ['11110','10001','10001','11110','10100','10010','10001'],
    'S': ['01111','10000','10000','01110','00001','00001','11110'],
    'T': ['11111','00100','00100','00100','00100','00100','00100'],
    'V': ['10001','10001','10001','10001','10001','01010','00100'],
    'Y': ['10001','10001','01010','00100','00100','00100','00100'],
    ' ': ['00000'] * 7,
}

def sample_image(marker):
    if marker not in ('A', 'B'):
        raise ValueError('Invented markers A/B only')
    width, height, scale = 840, 400, 7
    pixels = bytearray(b'\xff' * (width * height * 3))
    for line, text in enumerate(('SPINDLE ' + marker, 'READ ONLY IMAGE', 'INVENTED SAMPLE')):
        for column, char in enumerate(text):
            for y, row in enumerate(GLYPHS[char]):
                for x, on in enumerate(row):
                    if on == '1':
                        for dy in range(scale):
                            start = ((45 + line * 110 + y * scale + dy) * width + 35 + column * 6 * scale + x * scale) * 3
                            pixels[start:start + scale * 3] = b'\x17\x3b\x36' * scale
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    rows = b''.join(b'\0' + pixels[y * width * 3:(y + 1) * width * 3] for y in range(height))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')
