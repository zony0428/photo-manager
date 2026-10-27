"""
ローカル逆ジオコーダー (Local Offline Reverse Geocoder)
外部Web APIに依存せず、内蔵データセット (japan_cities.json, world_cities.json, countries.json)
と NumPy による高速近傍探索で、座標から「国・都道府県/州・市区町村」を特定する。
"""

import logging
import os
import json
import math
from typing import Dict, Optional, Tuple, Any
import numpy as np

logger = logging.getLogger(__name__)

# データファイル格納パス
_CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
_DATA_DIR = os.path.join(_CURRENT_DIR, "data")
_JAPAN_CITIES_PATH = os.path.join(_DATA_DIR, "japan_cities.json")
_WORLD_CITIES_PATH = os.path.join(_DATA_DIR, "world_cities.json")
_COUNTRIES_PATH = os.path.join(_DATA_DIR, "countries.json")


class LocalGeocoder:
    """
    ローカル逆ジオコーダークラス（シングルトン推奨）
    """

    def __init__(self):
        self._loaded = False
        self.japan_cities = []
        self.japan_lats = None
        self.japan_lngs = None

        self.world_cities = []
        self.world_lats = None
        self.world_lngs = None

        self.country_map = {}
        self.country_codes = []
        self.country_lats = None
        self.country_lngs = None

    def _ensure_loaded(self):
        """データセットをメモリに遅延ロードする"""
        if self._loaded:
            return

        # 1. 日本自治体データ
        if os.path.exists(_JAPAN_CITIES_PATH):
            with open(_JAPAN_CITIES_PATH, "r", encoding="utf-8") as f:
                self.japan_cities = json.load(f)
            if self.japan_cities:
                self.japan_lats = np.array([c[2] for c in self.japan_cities], dtype=np.float64)
                self.japan_lngs = np.array([c[3] for c in self.japan_cities], dtype=np.float64)

        # 2. 世界主要都市データ
        if os.path.exists(_WORLD_CITIES_PATH):
            with open(_WORLD_CITIES_PATH, "r", encoding="utf-8") as f:
                self.world_cities = json.load(f)
            if self.world_cities:
                self.world_lats = np.array([c[3] for c in self.world_cities], dtype=np.float64)
                self.world_lngs = np.array([c[4] for c in self.world_cities], dtype=np.float64)

        # 3. 世界の国データ
        if os.path.exists(_COUNTRIES_PATH):
            with open(_COUNTRIES_PATH, "r", encoding="utf-8") as f:
                self.country_map = json.load(f)
            if self.country_map:
                codes = []
                c_lats = []
                c_lngs = []
                for code, info in self.country_map.items():
                    codes.append(code)
                    c_lats.append(info.get("lat", 0.0))
                    c_lngs.append(info.get("lng", 0.0))
                self.country_codes = codes
                self.country_lats = np.array(c_lats, dtype=np.float64)
                self.country_lngs = np.array(c_lngs, dtype=np.float64)

        self._loaded = True

    def reverse_geocode(
        self,
        latitude: float,
        longitude: float,
        db_conn=None
    ) -> Dict[str, Optional[str]]:
        """
        緯度経度から {country, state, city} を返す。
        db_conn が渡された場合、geo_cache テーブルの確認および更新を行う。
        """
        if latitude is None or longitude is None:
            return {"country": None, "state": None, "city": None}
        if abs(float(latitude)) < 0.0001 and abs(float(longitude)) < 0.0001:
            return {"country": None, "state": None, "city": None}

        # 座標を小数点第2位（約1.1km精度）に丸めてキャッシュキー化
        lat_round = round(float(latitude), 2)
        lon_round = round(float(longitude), 2)

        # 1. キャッシュ確認
        if db_conn is not None:
            try:
                cursor = db_conn.cursor()
                cursor.execute(
                    "SELECT country, state, city FROM geo_cache WHERE lat_round = ? AND lon_round = ?",
                    (lat_round, lon_round)
                )
                row = cursor.fetchone()
                if row:
                    return {
                        "country": row[0] if isinstance(row, tuple) else row["country"],
                        "state": row[1] if isinstance(row, tuple) else row["state"],
                        "city": row[2] if isinstance(row, tuple) else row["city"],
                    }
            except Exception as e:
                logger.debug(f"ジオキャッシュ読み取りスキップ ({lat_round}, {lon_round}): {e}")

        # 2. メモリロード
        self._ensure_loaded()

        country: Optional[str] = None
        state: Optional[str] = None
        city: Optional[str] = None

        lat = float(latitude)
        lon = float(longitude)
        cos_lat = math.cos(math.radians(lat))

        # 3. 日本国内判定 (概算境界: 緯度20〜46, 経度122〜154)
        is_japan_candidate = (20.0 <= lat <= 46.0 and 122.0 <= lon <= 154.0)
        found_in_japan = False

        if is_japan_candidate and self.japan_lats is not None and len(self.japan_lats) > 0:
            # 緯度経度の概算ユークリッド距離二乗
            d_lat = self.japan_lats - lat
            d_lon = (self.japan_lngs - lon) * cos_lat
            d2 = d_lat * d_lat + d_lon * d_lon
            min_idx = int(np.argmin(d2))
            min_dist_deg = math.sqrt(d2[min_idx])

            # 約0.5度（約50km）以内なら日本の自治体と判定
            if min_dist_deg < 0.5:
                best = self.japan_cities[min_idx]
                country = "日本"
                state = best[0]
                city = best[1]
                found_in_japan = True

        # 4. 世界主要都市からの検索（日本で見つからなかった場合）
        if not found_in_japan and self.world_lats is not None and len(self.world_lats) > 0:
            d_lat = self.world_lats - lat
            d_lon = (self.world_lngs - lon) * cos_lat
            d2 = d_lat * d_lat + d_lon * d_lon
            min_idx = int(np.argmin(d2))
            min_dist_deg = math.sqrt(d2[min_idx])

            # 約1.5度（約150km）以内ならその都市・州を採用
            if min_dist_deg < 1.5:
                best_city = self.world_cities[min_idx]
                cc = best_city[0]
                state = best_city[1] or None
                city = best_city[2]
                c_info = self.country_map.get(cc, {})
                country = c_info.get("name_ja") or c_info.get("name_en") or cc
            else:
                # 5. フォールバック: 最寄りの国
                if self.country_lats is not None and len(self.country_lats) > 0:
                    cd_lat = self.country_lats - lat
                    cd_lon = (self.country_lngs - lon) * cos_lat
                    cd2 = cd_lat * cd_lat + cd_lon * cd_lon
                    c_min_idx = int(np.argmin(cd2))
                    best_cc = self.country_codes[c_min_idx]
                    c_info = self.country_map.get(best_cc, {})
                    country = c_info.get("name_ja") or c_info.get("name_en") or best_cc
                    state = None
                    city = None

        result = {"country": country, "state": state, "city": city}

        # 6. キャッシュ保存
        if db_conn is not None:
            try:
                cursor = db_conn.cursor()
                cursor.execute(
                    """
                    INSERT OR REPLACE INTO geo_cache (lat_round, lon_round, country, state, city)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (lat_round, lon_round, country, state, city)
                )
                db_conn.commit()
            except Exception as e:
                logger.warning(f"ジオキャッシュ書き込み失敗 ({lat_round}, {lon_round}): {e}")

        return result


# シングルトンインスタンス
_geocoder_instance: Optional[LocalGeocoder] = None


def get_geocoder() -> LocalGeocoder:
    """ローカル逆ジオコーダーのシングルトンインスタンスを取得する"""
    global _geocoder_instance
    if _geocoder_instance is None:
        _geocoder_instance = LocalGeocoder()
    return _geocoder_instance


def reverse_geocode(
    latitude: float,
    longitude: float,
    db_conn=None
) -> Dict[str, Optional[str]]:
    """
    座標から国・都道府県・市区町村を取得するコンビニエンス関数
    """
    return get_geocoder().reverse_geocode(latitude, longitude, db_conn=db_conn)
