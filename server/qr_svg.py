"""
純粋Pythonによる軽量・完全オフライン QRコード SVG 生成モジュール (ISO/IEC 18004 準拠)

目的:
- 外部通信（Google Chart API等）や追加pipパッケージに一切依存せず、
  PCのLAN接続URL (例: http://192.168.0.15:8088/m) を即座にSVG QRコードへ変換する。
- Version 1〜5 (誤り訂正レベル L: 単一ブロック最大106バイト) に対応。
"""

from typing import List, Optional, Tuple

# Version 1〜5 (Level L) の仕様定義: (version, size, data_codewords, ec_codewords, alignment_centers)
_VERSION_SPECS: List[Tuple[int, int, int, int, List[int]]] = [
    (1, 21, 19, 7, []),
    (2, 25, 34, 10, [6, 18]),
    (3, 29, 55, 15, [6, 22]),
    (4, 33, 80, 20, [6, 26]),
    (5, 37, 108, 26, [6, 30]),
]

# GF(256) 指数・対数テーブル (原始多項式 0x11D)
_GF_EXP = [0] * 512
_GF_LOG = [0] * 256
_val = 1
for _i in range(255):
    _GF_EXP[_i] = _val
    _GF_LOG[_val] = _i
    _val <<= 1
    if _val & 0x100:
        _val ^= 0x11D
for _i in range(255, 512):
    _GF_EXP[_i] = _GF_EXP[_i - 255]


def _gf_mul(a: int, b: int) -> int:
    if a == 0 or b == 0:
        return 0
    return _GF_EXP[_GF_LOG[a] + _GF_LOG[b]]


def _rs_generator_poly(degree: int) -> List[int]:
    """指定次数のReed-Solomon生成多項式を返す"""
    poly = [1]
    for i in range(degree):
        next_poly = [0] * (len(poly) + 1)
        root = _GF_EXP[i]
        for j, coeff in enumerate(poly):
            next_poly[j] ^= coeff
            next_poly[j + 1] ^= _gf_mul(coeff, root)
        poly = next_poly
    return poly


def _rs_encode(data: List[int], ec_len: int) -> List[int]:
    """データコード語配列からReed-Solomon誤り訂正コード語配列を算出する"""
    gen = _rs_generator_poly(ec_len)
    rem = [0] * ec_len
    for byte in data:
        factor = byte ^ rem[0]
        rem = rem[1:] + [0]
        if factor != 0:
            for i in range(ec_len):
                rem[i] ^= _gf_mul(gen[i + 1], factor)
    return rem


def _encode_data_codewords(payload: bytes, data_capacity: int) -> List[int]:
    """バイトモード (0100) でデータをビット列化し、パディングを含めたデータコード語を作成する"""
    bits: List[int] = []

    def append_bits(val: int, length: int) -> None:
        for i in range(length - 1, -1, -1):
            bits.append((val >> i) & 1)

    # モード指示子: Byte mode = 0100 (4 bits)
    append_bits(0b0100, 4)
    # 文字数指示子: Version 1〜9 の Byte mode は 8 bits
    append_bits(len(payload), 8)
    for b in payload:
        append_bits(b, 8)

    # 終端パターン (最大4ビットの0)
    max_bits = data_capacity * 8
    terminator_len = min(4, max_bits - len(bits))
    append_bits(0, terminator_len)

    # 8ビット境界揃え
    while len(bits) % 8 != 0:
        bits.append(0)

    codewords: List[int] = []
    for i in range(0, len(bits), 8):
        byte_val = 0
        for bit in bits[i : i + 8]:
            byte_val = (byte_val << 1) | bit
        codewords.append(byte_val)

    # 埋め草コード語 (0xEC, 0x11 を交互に付加)
    pad_bytes = (0xEC, 0x11)
    pad_idx = 0
    while len(codewords) < data_capacity:
        codewords.append(pad_bytes[pad_idx % 2])
        pad_idx += 1

    return codewords


def _compute_format_bits(mask_id: int) -> int:
    """誤り訂正レベル L (01) とマスク番号 (0〜7) から15ビットの形式情報を算出する"""
    # Level L = 01
    data = (0b01 << 3) | (mask_id & 0b111)
    rem = data << 10
    for i in range(4, -1, -1):
        if rem & (1 << (i + 10)):
            rem ^= 0x537 << i
    return ((data << 10) | rem) ^ 0x5412


def _place_format_bits(
    matrix: List[List[Optional[bool]]], is_function: List[List[bool]], mask_id: int
) -> None:
    """15ビットの形式情報をマトリクス上の所定位置に配置する"""
    size = len(matrix)
    fmt = _compute_format_bits(mask_id)

    # 左上ファインダ周辺
    coords_tl = [
        (8, 0), (8, 1), (8, 2), (8, 3), (8, 4), (8, 5),
        (8, 7), (8, 8), (7, 8), (5, 8), (4, 8), (3, 8),
        (2, 8), (1, 8), (0, 8),
    ]
    for i, (r, c) in enumerate(coords_tl):
        bit = bool((fmt >> (14 - i)) & 1)
        matrix[r][c] = bit
        is_function[r][c] = True

    # 右上および左下ファインダ周辺 (bit 14 -> bit 0)
    coords_tr_bl = [
        (size - 1, 8), (size - 2, 8), (size - 3, 8), (size - 4, 8),
        (size - 5, 8), (size - 6, 8), (size - 7, 8),
        (8, size - 8), (8, size - 7), (8, size - 6), (8, size - 5),
        (8, size - 4), (8, size - 3), (8, size - 2), (8, size - 1),
    ]
    for i, (r, c) in enumerate(coords_tr_bl):
        bit = bool((fmt >> (14 - i)) & 1)
        matrix[r][c] = bit
        is_function[r][c] = True


def _build_base_matrix(
    size: int, align_centers: List[int]
) -> Tuple[List[List[Optional[bool]]], List[List[bool]]]:
    """機能パターン（ファインダ・アライメント・タイミング・ダークモジュール・形式予約領域）を配置する"""
    matrix: List[List[Optional[bool]]] = [[None] * size for _ in range(size)]
    is_func: List[List[bool]] = [[False] * size for _ in range(size)]

    def set_func(r: int, c: int, val: bool) -> None:
        if 0 <= r < size and 0 <= c < size:
            matrix[r][c] = val
            is_func[r][c] = True

    # 1. ファインダパターン (7x7) + セパレータ (白枠)
    for fr, fc in ((0, 0), (0, size - 7), (size - 7, 0)):
        for dr in range(-1, 8):
            for dc in range(-1, 8):
                r, c = fr + dr, fc + dc
                if 0 <= r < size and 0 <= c < size:
                    if 0 <= dr <= 6 and 0 <= dc <= 6:
                        is_dark = (
                            dr in (0, 6)
                            or dc in (0, 6)
                            or (2 <= dr <= 4 and 2 <= dc <= 4)
                        )
                        set_func(r, c, is_dark)
                    else:
                        set_func(r, c, False)

    # 2. アライメントパターン (5x5)
    for ar in align_centers:
        for ac in align_centers:
            # ファインダと重なる3隅は除外
            if (ar == 6 and ac == 6) or (ar == 6 and ac == size - 7) or (ar == size - 7 and ac == 6):
                continue
            for dr in range(-2, 3):
                for dc in range(-2, 3):
                    is_dark = abs(dr) == 2 or abs(dc) == 2 or (dr == 0 and dc == 0)
                    set_func(ar + dr, ac + dc, is_dark)

    # 3. タイミングパターン (6行目・6列目)
    for i in range(8, size - 8):
        if not is_func[6][i]:
            set_func(6, i, i % 2 == 0)
        if not is_func[i][6]:
            set_func(i, 6, i % 2 == 0)

    # 4. ダークモジュール
    set_func(size - 8, 8, True)

    # 5. 形式情報の予約領域をマーク
    _place_format_bits(matrix, is_func, 0)

    return matrix, is_func


def generate_qr_matrix(text: str) -> List[List[bool]]:
    """文字列からQRコードの2次元真偽値マトリクスを生成する"""
    payload = text.encode("utf-8")
    selected_spec = None
    for spec in _VERSION_SPECS:
        # 4 bit (mode) + 8 bit (len) + payload <= data_codewords * 8
        if len(payload) + 2 <= spec[2]:
            selected_spec = spec
            break
    if selected_spec is None:
        raise ValueError(f"QRコードの最大データ長を超えています ({len(payload)} bytes)")

    _, size, data_cw_len, ec_cw_len, align_centers = selected_spec
    data_cw = _encode_data_codewords(payload, data_cw_len)
    ec_cw = _rs_encode(data_cw, ec_cw_len)
    all_cw = data_cw + ec_cw

    all_bits: List[int] = []
    for cw in all_cw:
        for i in range(7, -1, -1):
            all_bits.append((cw >> i) & 1)

    matrix, is_func = _build_base_matrix(size, align_centers)

    # ジグザグ配置 (右端から2列ずつ上下交互に走査、列6はスキップ)
    bit_idx = 0
    col = size - 1
    upward = True
    while col > 0:
        if col == 6:
            col -= 1
        row_range = range(size - 1, -1, -1) if upward else range(size)
        for r in row_range:
            for dc in (0, 1):
                c = col - dc
                if not is_func[r][c]:
                    bit_val = bool(all_bits[bit_idx]) if bit_idx < len(all_bits) else False
                    bit_idx += 1
                    # マスクパターン 0: (r + c) % 2 == 0
                    if (r + c) % 2 == 0:
                        bit_val = not bit_val
                    matrix[r][c] = bit_val
        upward = not upward
        col -= 2

    _place_format_bits(matrix, is_func, 0)
    return [[bool(cell) for cell in row] for row in matrix]


def generate_qr_svg(text: str, border: int = 3) -> str:
    """
    指定テキストのQRコードを軽量なインラインSVG文字列として返す。
    白いクワイエットゾーン(border)を含み、ダークテーマ上でもスマホカメラで確実に認識できる。
    """
    matrix = generate_qr_matrix(text)
    size = len(matrix)
    total = size + border * 2
    paths: List[str] = []
    for r, row in enumerate(matrix):
        for c, is_dark in enumerate(row):
            if is_dark:
                paths.append(f"M{c + border},{r + border}h1v1h-1z")
    path_data = "".join(paths)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {total} {total}" '
        f'width="148" height="148" shape-rendering="crispEdges" role="img" aria-label="QR Code">'
        f'<rect width="{total}" height="{total}" fill="#ffffff" rx="2"/>'
        f'<path d="{path_data}" fill="#000000"/>'
        f"</svg>"
    )
