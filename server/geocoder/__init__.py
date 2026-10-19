"""
ローカル逆ジオコーダーパッケージ
座標 (lat, lon) から 国・都道府県(州)・市区町村 をオフライン高速判定する。
"""

from .local_geocoder import reverse_geocode, get_geocoder

__all__ = ["reverse_geocode", "get_geocoder"]
