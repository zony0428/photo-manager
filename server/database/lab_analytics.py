"""
ラボ分析・ジオタグヒートマップ・撮影統計カルテ管理モジュール
47都道府県の正規化・制覇白地図・撮影密度ヒートマップ・撮影さんぽ軌跡、
勝ちレンズ・得意設定カルテ、および未整理フォルダ発掘ガチャの集計処理を提供する。
"""

from datetime import datetime
import logging
import os
import random
from typing import Any, Dict, List, Optional, Tuple

from .connection import get_connection

logger = logging.getLogger(__name__)

# シャッタースピード文字列（分数 "1/250" または小数 "0.5" / "2.5s"）を露光秒数(REAL)に換算するSQL式
_SHUTTER_SECONDS_SQL = """(CASE
    WHEN INSTR(p.shutter_speed, '/') > 0 THEN
        CASE
            WHEN CAST(SUBSTR(p.shutter_speed, INSTR(p.shutter_speed, '/') + 1) AS REAL) > 0
            THEN CAST(SUBSTR(p.shutter_speed, 1, INSTR(p.shutter_speed, '/') - 1) AS REAL)
                 / CAST(SUBSTR(p.shutter_speed, INSTR(p.shutter_speed, '/') + 1) AS REAL)
            ELSE 0.0
        END
    ELSE CAST(REPLACE(p.shutter_speed, 's', '') AS REAL)
END)"""

# 日本の47都道府県定義（正式名称, 短縮名, 英語名リスト）
_JP_PREF_DEFS: List[Tuple[str, str, List[str]]] = [
    ("北海道", "北海道", ["hokkaido"]),
    ("青森県", "青森", ["aomori"]),
    ("岩手県", "岩手", ["iwate"]),
    ("宮城県", "宮城", ["miyagi"]),
    ("秋田県", "秋田", ["akita"]),
    ("山形県", "山形", ["yamagata"]),
    ("福島県", "福島", ["fukushima"]),
    ("茨城県", "茨城", ["ibaraki"]),
    ("栃木県", "栃木", ["tochigi"]),
    ("群馬県", "群馬", ["gunma", "gumma"]),
    ("埼玉県", "埼玉", ["saitama"]),
    ("千葉県", "千葉", ["chiba"]),
    ("東京都", "東京", ["tokyo", "tokyo metropolis", "tokyo-to"]),
    ("神奈川県", "神奈川", ["kanagawa"]),
    ("新潟県", "新潟", ["niigata"]),
    ("富山県", "富山", ["toyama"]),
    ("石川県", "石川", ["ishikawa"]),
    ("福井県", "福井", ["fukui"]),
    ("山梨県", "山梨", ["yamanashi"]),
    ("長野県", "長野", ["nagano"]),
    ("岐阜県", "岐阜", ["gifu"]),
    ("静岡県", "静岡", ["shizuoka"]),
    ("愛知県", "愛知", ["aichi"]),
    ("三重県", "三重", ["mie"]),
    ("滋賀県", "滋賀", ["shiga"]),
    ("京都府", "京都", ["kyoto", "kyoto-fu"]),
    ("大阪府", "大阪", ["osaka", "osaka-fu"]),
    ("兵庫県", "兵庫", ["hyogo", "hyōgo"]),
    ("奈良県", "奈良", ["nara"]),
    ("和歌山県", "和歌山", ["wakayama"]),
    ("鳥取県", "鳥取", ["tottori"]),
    ("島根県", "島根", ["shimane"]),
    ("岡山県", "岡山", ["okayama"]),
    ("広島県", "広島", ["hiroshima"]),
    ("山口県", "山口", ["yamaguchi"]),
    ("徳島県", "徳島", ["tokushima"]),
    ("香川県", "香川", ["kagawa"]),
    ("愛媛県", "愛媛", ["ehime"]),
    ("高知県", "高知", ["kochi", "kōchi"]),
    ("福岡県", "福岡", ["fukuoka"]),
    ("佐賀県", "佐賀", ["saga"]),
    ("長崎県", "長崎", ["nagasaki"]),
    ("熊本県", "熊本", ["kumamoto"]),
    ("大分県", "大分", ["oita", "ōita"]),
    ("宮崎県", "宮崎", ["miyazaki"]),
    ("鹿児島県", "鹿児島", ["kagoshima"]),
    ("沖縄県", "沖縄", ["okinawa"]),
]

_PREF_LOOKUP_MAP: Dict[str, str] = {}
_PREF_ALIASES_MAP: Dict[str, List[str]] = {}
for _full_jp, _short_jp, _en_list in _JP_PREF_DEFS:
    _aliases = {_full_jp, _short_jp}
    _PREF_LOOKUP_MAP[_full_jp.lower()] = _full_jp
    _PREF_LOOKUP_MAP[_short_jp.lower()] = _full_jp
    for _en in _en_list:
        _PREF_LOOKUP_MAP[_en.lower()] = _full_jp
        _PREF_LOOKUP_MAP[f"{_en.lower()} prefecture"] = _full_jp
        _PREF_LOOKUP_MAP[f"{_en.lower()}-ken"] = _full_jp
        _aliases.add(_en.capitalize())
        _aliases.add(f"{_en.capitalize()} Prefecture")
    _PREF_ALIASES_MAP[_full_jp] = sorted(_aliases)


def _normalize_jp_prefecture(state: Optional[str], country: Optional[str] = None) -> Optional[str]:
    """
    都道府県名（日本語正式名・短縮名・英語名など）を日本の47都道府県の正式名称に正規化する。
    47都道府県に該当しない場合は None を返す。
    """
    if not state:
        return None
    if country and country not in ("日本", "Japan", "JP", ""):
        # 国名が明示的に海外の場合は除外（ただしstate自体が日本の都道府県名なら許容）
        pass
    s_clean = str(state).strip()
    if not s_clean:
        return None
    s_lower = s_clean.lower()
    if s_lower in _PREF_LOOKUP_MAP:
        return _PREF_LOOKUP_MAP[s_lower]
    # "Prefecture" や空白を除去して再照合
    s_stripped = s_lower.replace("prefecture", "").replace("metropolis", "").strip()
    if s_stripped in _PREF_LOOKUP_MAP:
        return _PREF_LOOKUP_MAP[s_stripped]
    return None


def _get_jp_prefecture_aliases(state: str) -> List[str]:
    """指定された都道府県名に対応する表記ゆれ候補リスト（日本語・英語等）を返す"""
    norm = _normalize_jp_prefecture(state)
    if norm and norm in _PREF_ALIASES_MAP:
        return _PREF_ALIASES_MAP[norm]
    return [state]


def get_location_heatmap_data(date_filter: Optional[str] = None) -> Dict[str, Any]:
    """
    ジオタグ47都道府県制覇マップ・ヒートマップ・時系列撮影軌跡（フォトラリー）用の集計データを取得する。
    """
    from .photos import backfill_photo_locations

    try:
        backfill_photo_locations(limit=5000)
    except Exception as e:
        logger.warning(f"ヒートマップ集計前の自動逆ジオコーディングをスキップしました: {e}")

    with get_connection() as conn:
        cursor = conn.cursor()

        # 1. 国・都道府県ごとの枚数・優/良枚数・中心座標集計
        cursor.execute(
            """
            SELECT country, state,
                   COUNT(*) AS cnt,
                   SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) AS exc_cnt,
                   SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END) AS good_cnt,
                   AVG(latitude) AS avg_lat,
                   AVG(longitude) AS avg_lon
            FROM photos
            WHERE (is_unlinked IS NULL OR is_unlinked = 0)
              AND NOT (is_raw = 1 AND paired_raw_path IS NOT NULL)
              AND latitude IS NOT NULL AND longitude IS NOT NULL
              AND (ABS(latitude) >= 0.0001 OR ABS(longitude) >= 0.0001)
            GROUP BY country, state
            """
        )
        loc_rows = cursor.fetchall()

        total_geotagged = 0
        pref_agg: Dict[str, Dict[str, Any]] = {}
        country_agg: Dict[str, Dict[str, Any]] = {}

        for r in loc_rows:
            cnt = int(r["cnt"] or 0)
            exc = int(r["exc_cnt"] or 0)
            good = int(r["good_cnt"] or 0)
            avg_lat = float(r["avg_lat"] or 35.68)
            avg_lon = float(r["avg_lon"] or 139.76)
            raw_country = (r["country"] or "").strip()
            raw_state = (r["state"] or "").strip()

            total_geotagged += cnt

            norm_pref = _normalize_jp_prefecture(raw_state, raw_country)
            if norm_pref:
                c_name = "日本"
            elif raw_country in ("日本", "Japan", "JP"):
                c_name = "日本"
            elif raw_country:
                c_name = raw_country
            else:
                c_name = "不明"

            if c_name not in country_agg:
                country_agg[c_name] = {"country": c_name, "count": 0, "excellent_count": 0}
            country_agg[c_name]["count"] += cnt
            country_agg[c_name]["excellent_count"] += exc

            if norm_pref:
                if norm_pref not in pref_agg:
                    pref_agg[norm_pref] = {
                        "prefecture": norm_pref,
                        "country": "日本",
                        "count": 0,
                        "excellent_count": 0,
                        "good_count": 0,
                        "_lat_sum": 0.0,
                        "_lon_sum": 0.0,
                    }
                pref_agg[norm_pref]["count"] += cnt
                pref_agg[norm_pref]["excellent_count"] += exc
                pref_agg[norm_pref]["good_count"] += good
                pref_agg[norm_pref]["_lat_sum"] += avg_lat * cnt
                pref_agg[norm_pref]["_lon_sum"] += avg_lon * cnt

        prefectures_list: List[Dict[str, Any]] = []
        for p_name, p_info in pref_agg.items():
            c_total = p_info["count"]
            prefectures_list.append({
                "prefecture": p_name,
                "country": "日本",
                "count": c_total,
                "excellent_count": p_info["excellent_count"],
                "good_count": p_info["good_count"],
                "avg_lat": round(p_info["_lat_sum"] / c_total, 4) if c_total > 0 else 35.68,
                "avg_lon": round(p_info["_lon_sum"] / c_total, 4) if c_total > 0 else 139.76,
            })
        prefectures_list.sort(key=lambda x: (-x["count"], x["prefecture"]))

        countries_list = sorted(
            country_agg.values(), key=lambda x: (-x["count"], x["country"])
        )

        # 2. グリッドヒートマップ用ポイント集計 (約1kmメッシュ: 小数点第2位丸め)
        cursor.execute(
            """
            SELECT ROUND(latitude, 2) AS lat,
                   ROUND(longitude, 2) AS lon,
                   COUNT(*) AS count,
                   SUM(CASE WHEN rating = 2 THEN 1 ELSE 0 END) AS excellent_count,
                   MAX(state) AS state,
                   MAX(city) AS city
            FROM photos
            WHERE (is_unlinked IS NULL OR is_unlinked = 0)
              AND NOT (is_raw = 1 AND paired_raw_path IS NOT NULL)
              AND latitude IS NOT NULL AND longitude IS NOT NULL
              AND (ABS(latitude) >= 0.0001 OR ABS(longitude) >= 0.0001)
            GROUP BY ROUND(latitude, 2), ROUND(longitude, 2)
            ORDER BY count DESC
            LIMIT 2000
            """
        )
        grid_points = [
            {
                "lat": float(r["lat"]),
                "lon": float(r["lon"]),
                "count": int(r["count"] or 0),
                "excellent_count": int(r["excellent_count"] or 0),
                "state": _normalize_jp_prefecture(r["state"]) or (r["state"] or ""),
                "city": r["city"] or "",
            }
            for r in cursor.fetchall()
            if r["lat"] is not None and r["lon"] is not None
        ]

        # 3. 撮影軌跡（フォトラリー）用の日付一覧（最新順・最大100日分）
        cursor.execute(
            """
            SELECT SUBSTR(date_taken, 1, 10) AS dt,
                   COUNT(*) AS cnt,
                   MAX(state) AS main_state,
                   MAX(city) AS main_city
            FROM photos
            WHERE (is_unlinked IS NULL OR is_unlinked = 0)
              AND NOT (is_raw = 1 AND paired_raw_path IS NOT NULL)
              AND latitude IS NOT NULL AND longitude IS NOT NULL
              AND (ABS(latitude) >= 0.0001 OR ABS(longitude) >= 0.0001)
              AND date_taken IS NOT NULL AND LENGTH(date_taken) >= 10
            GROUP BY SUBSTR(date_taken, 1, 10)
            ORDER BY dt DESC
            LIMIT 100
            """
        )
        trajectory_dates: List[Dict[str, Any]] = []
        for r in cursor.fetchall():
            dt_str = str(r["dt"] or "").replace(":", "-")
            cnt = int(r["cnt"] or 0)
            st = _normalize_jp_prefecture(r["main_state"]) or (r["main_state"] or "")
            ci = r["main_city"] or ""
            loc_label = f"{st} {ci}".strip() if (st or ci) else "位置情報あり"
            trajectory_dates.append({
                "date": dt_str,
                "count": cnt,
                "state": st,
                "city": ci,
                "label": f"{dt_str} ({loc_label} / {cnt}枚)",
            })

        # 4. 撮影軌跡ポイント一覧（date_filter 指定時はその日、未指定時は最新側から最大1,500件を時系列昇順で返却）
        if date_filter and len(date_filter.strip()) >= 7:
            df_clean = date_filter.strip()
            cursor.execute(
                """
                SELECT id, file_name, date_taken, latitude, longitude, state, city, rating
                FROM photos
                WHERE (is_unlinked IS NULL OR is_unlinked = 0)
                  AND NOT (is_raw = 1 AND paired_raw_path IS NOT NULL)
                  AND latitude IS NOT NULL AND longitude IS NOT NULL
                  AND (ABS(latitude) >= 0.0001 OR ABS(longitude) >= 0.0001)
                  AND date_taken IS NOT NULL
                  AND SUBSTR(REPLACE(date_taken, ':', '-'), 1, ?) = ?
                ORDER BY date_taken ASC, id ASC
                LIMIT 1500
                """,
                (len(df_clean), df_clean),
            )
            traj_rows = cursor.fetchall()
        else:
            cursor.execute(
                """
                SELECT id, file_name, date_taken, latitude, longitude, state, city, rating
                FROM (
                    SELECT id, file_name, date_taken, latitude, longitude, state, city, rating
                    FROM photos
                    WHERE (is_unlinked IS NULL OR is_unlinked = 0)
                      AND NOT (is_raw = 1 AND paired_raw_path IS NOT NULL)
                      AND latitude IS NOT NULL AND longitude IS NOT NULL
                      AND (ABS(latitude) >= 0.0001 OR ABS(longitude) >= 0.0001)
                      AND date_taken IS NOT NULL AND date_taken != ''
                    ORDER BY date_taken DESC, id DESC
                    LIMIT 1500
                )
                ORDER BY date_taken ASC, id ASC
                """
            )
            traj_rows = cursor.fetchall()

        trajectory_points = [
            {
                "id": r["id"],
                "file_name": r["file_name"],
                "date_taken": r["date_taken"],
                "lat": float(r["latitude"]),
                "lon": float(r["longitude"]),
                "state": _normalize_jp_prefecture(r["state"]) or (r["state"] or ""),
                "city": r["city"] or "",
                "rating": int(r["rating"] or 0),
            }
            for r in traj_rows
            if r["latitude"] is not None and r["longitude"] is not None
        ]

        return {
            "prefectures": prefectures_list,
            "countries": countries_list,
            "conquered_prefectures_count": len(prefectures_list),
            "total_prefectures": 47,
            "total_geotagged": total_geotagged,
            "grid_points": grid_points,
            "trajectory_dates": trajectory_dates,
            "trajectory_points": trajectory_points,
        }


def get_lab_karte_data(today_mmdd: Optional[str] = None) -> Dict[str, Any]:
    """
    パーソナル撮影ラボ＆機材相性カルテ（歩留まり分析・焦点距離/F値別統計・太陽高度別枚数・時間帯分布・過去の今日）を集計する。
    """
    if not today_mmdd or len(today_mmdd.strip()) != 5:
        today_mmdd = datetime.now().strftime("%m-%d")
    else:
        today_mmdd = today_mmdd.strip()

    base_where = (
        "(p.is_unlinked IS NULL OR p.is_unlinked = 0)"
        " AND NOT (p.is_raw = 1 AND p.paired_raw_path IS NOT NULL)"
    )

    with get_connection() as conn:
        cursor = conn.cursor()

        # 1. サマリー集計（全体枚数・優/良枚数・手ブレリスク・ゴールデン/ブルーアワー・過去の今日）
        cursor.execute(
            f"""
            SELECT
                COUNT(*) AS total_photos,
                SUM(CASE WHEN p.rating IN (-1, 1, 2) THEN 1 ELSE 0 END) AS rated_photos,
                SUM(CASE WHEN p.rating = 2 THEN 1 ELSE 0 END) AS excellent_count,
                SUM(CASE WHEN p.rating = 1 THEN 1 ELSE 0 END) AS good_count,
                SUM(CASE WHEN p.rating = 0 THEN 1 ELSE 0 END) AS acceptable_count,
                SUM(CASE WHEN p.rating = -1 THEN 1 ELSE 0 END) AS reject_count,
                SUM(CASE
                    WHEN p.focal_length IS NOT NULL AND p.focal_length > 0
                         AND p.shutter_speed IS NOT NULL AND p.shutter_speed != ''
                         AND ({_SHUTTER_SECONDS_SQL} * p.focal_length) >= 1.0
                    THEN 1 ELSE 0
                END) AS shake_risk_count,
                SUM(CASE
                    WHEN p.date_taken IS NOT NULL AND p.date_taken != ''
                         AND solar_altitude(p.date_taken, p.latitude, p.longitude) BETWEEN -4.0 AND 6.0
                    THEN 1 ELSE 0
                END) AS golden_hour_count,
                SUM(CASE
                    WHEN p.date_taken IS NOT NULL AND p.date_taken != ''
                         AND solar_altitude(p.date_taken, p.latitude, p.longitude) BETWEEN -8.0 AND -4.0001
                    THEN 1 ELSE 0
                END) AS blue_hour_count,
                SUM(CASE
                    WHEN p.date_taken IS NOT NULL AND p.date_taken != ''
                         AND solar_altitude(p.date_taken, p.latitude, p.longitude) < -8.0
                    THEN 1 ELSE 0
                END) AS night_count,
                SUM(CASE
                    WHEN p.date_taken IS NOT NULL AND SUBSTR(p.date_taken, 6, 5) IN (?, ?)
                    THEN 1 ELSE 0
                END) AS on_this_day_count
            FROM photos p
            WHERE {base_where}
            """,
            (today_mmdd.replace(":", "-"), today_mmdd.replace("-", ":")),
        )
        sum_row = cursor.fetchone()
        total_photos = int(sum_row["total_photos"] or 0) if sum_row else 0
        rated_photos = int(sum_row["rated_photos"] or 0) if sum_row else 0
        excellent_count = int(sum_row["excellent_count"] or 0) if sum_row else 0
        good_count = int(sum_row["good_count"] or 0) if sum_row else 0
        acceptable_count = int(sum_row["acceptable_count"] or 0) if sum_row else 0
        reject_count = int(sum_row["reject_count"] or 0) if sum_row else 0
        shake_risk_count = int(sum_row["shake_risk_count"] or 0) if sum_row else 0
        golden_hour_count = int(sum_row["golden_hour_count"] or 0) if sum_row else 0
        blue_hour_count = int(sum_row["blue_hour_count"] or 0) if sum_row else 0
        night_count = int(sum_row["night_count"] or 0) if sum_row else 0
        on_this_day_count = int(sum_row["on_this_day_count"] or 0) if sum_row else 0

        overall_excellent_rate = round(excellent_count * 100.0 / total_photos, 1) if total_photos > 0 else 0.0
        overall_hit_rate = round((excellent_count + good_count) * 100.0 / total_photos, 1) if total_photos > 0 else 0.0

        summary = {
            "total_photos": total_photos,
            "rated_photos": rated_photos,
            "excellent_count": excellent_count,
            "good_count": good_count,
            "acceptable_count": acceptable_count,
            "reject_count": reject_count,
            "overall_excellent_rate": overall_excellent_rate,
            "overall_hit_rate": overall_hit_rate,
            "shake_risk_count": shake_risk_count,
            "golden_hour_count": golden_hour_count,
            "blue_hour_count": blue_hour_count,
            "magic_all_count": golden_hour_count + blue_hour_count,
            "night_count": night_count,
            "on_this_day_count": on_this_day_count,
            "today_mmdd": today_mmdd,
        }

        # 2. カメラ＋レンズ別の歩留まり（打率）ランキング
        cursor.execute(
            f"""
            SELECT
                COALESCE(NULLIF(TRIM(p.camera_model), ''), '不明') AS cam,
                CASE
                    WHEN p.lens_model IS NULL OR TRIM(p.lens_model) = '' THEN '__NONE__'
                    ELSE TRIM(p.lens_model)
                END AS lens,
                COUNT(*) AS total,
                SUM(CASE WHEN p.rating = 2 THEN 1 ELSE 0 END) AS excellent,
                SUM(CASE WHEN p.rating = 1 THEN 1 ELSE 0 END) AS good,
                SUM(CASE WHEN p.rating = 0 THEN 1 ELSE 0 END) AS acceptable,
                SUM(CASE WHEN p.rating = -1 THEN 1 ELSE 0 END) AS reject
            FROM photos p
            WHERE {base_where}
            GROUP BY cam, lens
            """
        )
        lenses_list: List[Dict[str, Any]] = []
        for r in cursor.fetchall():
            tot = int(r["total"] or 0)
            if tot <= 0:
                continue
            exc = int(r["excellent"] or 0)
            gd = int(r["good"] or 0)
            acc = int(r["acceptable"] or 0)
            rej = int(r["reject"] or 0)
            cam_name = r["cam"]
            lens_raw = r["lens"]
            lens_label = "レンズ情報なし" if lens_raw == "__NONE__" else lens_raw
            exc_rate = round(exc * 100.0 / tot, 1)
            hit_rate = round((exc + gd) * 100.0 / tot, 1)
            lenses_list.append({
                "camera_model": cam_name,
                "lens_model": lens_raw,
                "label": lens_label,
                "full_label": f"{cam_name} / {lens_label}",
                "filter_key": f"{cam_name}::{lens_raw}",
                "total": tot,
                "excellent": exc,
                "good": gd,
                "acceptable": acc,
                "reject": rej,
                "excellent_rate": exc_rate,
                "hit_rate": hit_rate,
            })
        lenses_list.sort(key=lambda x: (-x["excellent_rate"], -x["hit_rate"], -x["total"]))

        # 3. カメラモデル別の歩留まり集計
        cursor.execute(
            f"""
            SELECT
                COALESCE(NULLIF(TRIM(p.camera_model), ''), '不明') AS cam,
                COUNT(*) AS total,
                SUM(CASE WHEN p.rating = 2 THEN 1 ELSE 0 END) AS excellent,
                SUM(CASE WHEN p.rating = 1 THEN 1 ELSE 0 END) AS good,
                SUM(CASE WHEN p.rating = 0 THEN 1 ELSE 0 END) AS acceptable,
                SUM(CASE WHEN p.rating = -1 THEN 1 ELSE 0 END) AS reject
            FROM photos p
            WHERE {base_where}
            GROUP BY cam
            """
        )
        cameras_list: List[Dict[str, Any]] = []
        for r in cursor.fetchall():
            tot = int(r["total"] or 0)
            if tot <= 0:
                continue
            exc = int(r["excellent"] or 0)
            gd = int(r["good"] or 0)
            acc = int(r["acceptable"] or 0)
            rej = int(r["reject"] or 0)
            cameras_list.append({
                "camera_model": r["cam"],
                "total": tot,
                "excellent": exc,
                "good": gd,
                "acceptable": acc,
                "reject": rej,
                "excellent_rate": round(exc * 100.0 / tot, 1),
                "hit_rate": round((exc + gd) * 100.0 / tot, 1),
            })
        cameras_list.sort(key=lambda x: (-x["excellent_rate"], -x["hit_rate"], -x["total"]))

        # 4. 焦点距離域（5区分）の集計
        focal_defs = [
            ("0-23.9", "超広角〜広角 (<24mm)", 0.0, 23.999),
            ("24-70", "標準域 (24-70mm)", 24.0, 70.0),
            ("70.1-135", "中望遠 (71-135mm)", 70.001, 135.0),
            ("135.1-300", "望遠 (136-300mm)", 135.001, 300.0),
            ("300.1-9999", "超望遠 (300mm超)", 300.001, 99999.0),
        ]
        focal_ranges: List[Dict[str, Any]] = []
        for f_key, f_label, f_min, f_max in focal_defs:
            cursor.execute(
                f"""
                SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN p.rating = 2 THEN 1 ELSE 0 END) AS excellent,
                    SUM(CASE WHEN p.rating = 1 THEN 1 ELSE 0 END) AS good,
                    SUM(CASE WHEN p.rating = 0 THEN 1 ELSE 0 END) AS acceptable,
                    SUM(CASE WHEN p.rating = -1 THEN 1 ELSE 0 END) AS reject
                FROM photos p
                WHERE {base_where}
                  AND p.focal_length IS NOT NULL
                  AND p.focal_length BETWEEN ? AND ?
                """,
                (f_min, f_max),
            )
            fr = cursor.fetchone()
            tot = int(fr["total"] or 0) if fr else 0
            exc = int(fr["excellent"] or 0) if fr else 0
            gd = int(fr["good"] or 0) if fr else 0
            acc = int(fr["acceptable"] or 0) if fr else 0
            rej = int(fr["reject"] or 0) if fr else 0
            focal_ranges.append({
                "range": f_key,
                "key": f_key,
                "label": f_label,
                "total": tot,
                "excellent": exc,
                "good": gd,
                "acceptable": acc,
                "reject": rej,
                "excellent_rate": round(exc * 100.0 / tot, 1) if tot > 0 else 0.0,
                "hit_rate": round((exc + gd) * 100.0 / tot, 1) if tot > 0 else 0.0,
            })

        # 5. F値（絞り）域（5区分）の集計
        aperture_defs = [
            ("0.7-2.0", "大口径・開放 (〜F2.0)", 0.7, 2.0),
            ("2.1-3.5", "明るい (F2.2〜F3.5)", 2.001, 3.5),
            ("3.6-5.6", "標準絞り (F4.0〜F5.6)", 3.501, 5.6),
            ("5.7-11", "パンフォーカス (F6.3〜F11)", 5.601, 11.0),
            ("11.1-99", "小絞り (F13〜)", 11.001, 99.0),
        ]
        aperture_ranges: List[Dict[str, Any]] = []
        for a_key, a_label, a_min, a_max in aperture_defs:
            cursor.execute(
                f"""
                SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN p.rating = 2 THEN 1 ELSE 0 END) AS excellent,
                    SUM(CASE WHEN p.rating = 1 THEN 1 ELSE 0 END) AS good,
                    SUM(CASE WHEN p.rating = 0 THEN 1 ELSE 0 END) AS acceptable,
                    SUM(CASE WHEN p.rating = -1 THEN 1 ELSE 0 END) AS reject
                FROM photos p
                WHERE {base_where}
                  AND p.f_number IS NOT NULL
                  AND p.f_number BETWEEN ? AND ?
                """,
                (a_min, a_max),
            )
            ar = cursor.fetchone()
            tot = int(ar["total"] or 0) if ar else 0
            exc = int(ar["excellent"] or 0) if ar else 0
            gd = int(ar["good"] or 0) if ar else 0
            acc = int(ar["acceptable"] or 0) if ar else 0
            rej = int(ar["reject"] or 0) if ar else 0
            aperture_ranges.append({
                "range": a_key,
                "key": a_key,
                "label": a_label,
                "total": tot,
                "excellent": exc,
                "good": gd,
                "acceptable": acc,
                "reject": rej,
                "excellent_rate": round(exc * 100.0 / tot, 1) if tot > 0 else 0.0,
                "hit_rate": round((exc + gd) * 100.0 / tot, 1) if tot > 0 else 0.0,
            })

        # 6. 時間帯別（0〜23時）の撮影リズム分布
        cursor.execute(
            f"""
            SELECT
                CAST(SUBSTR(p.date_taken, 12, 2) AS INTEGER) AS hr,
                COUNT(*) AS cnt,
                SUM(CASE WHEN p.rating = 2 THEN 1 ELSE 0 END) AS exc_cnt,
                SUM(CASE WHEN p.rating = 1 THEN 1 ELSE 0 END) AS good_cnt
            FROM photos p
            WHERE {base_where}
              AND p.date_taken IS NOT NULL AND LENGTH(p.date_taken) >= 13
            GROUP BY hr
            """
        )
        hr_map: Dict[int, Dict[str, int]] = {}
        for r in cursor.fetchall():
            h_val = r["hr"]
            if h_val is not None and 0 <= int(h_val) <= 23:
                hr_map[int(h_val)] = {
                    "count": int(r["cnt"] or 0),
                    "excellent": int(r["exc_cnt"] or 0),
                    "good": int(r["good_cnt"] or 0),
                }

        hourly_distribution: List[Dict[str, Any]] = []
        for h in range(24):
            h_info = hr_map.get(h, {"count": 0, "excellent": 0, "good": 0})
            tot_h = h_info["count"]
            exc_h = h_info["excellent"]
            gd_h = h_info["good"]
            hourly_distribution.append({
                "hour": h,
                "label": f"{h:02d}:00",
                "count": tot_h,
                "total": tot_h,
                "excellent": exc_h,
                "excellent_count": exc_h,
                "good": gd_h,
                "good_count": gd_h,
                "excellent_rate": round(exc_h * 100.0 / tot_h, 1) if tot_h > 0 else 0.0,
            })

        return {
            "summary": summary,
            "lenses": lenses_list,
            "cameras": cameras_list,
            "focal_ranges": focal_ranges,
            "aperture_ranges": aperture_ranges,
            "hourly_distribution": hourly_distribution,
        }


def get_random_unrated_folder() -> Dict[str, Any]:
    """
    未整理（rating = 0: 可）の写真が残っているフォルダをランダムに1つ抽選して返す（未整理フォルダ発掘ガチャ用）。
    """
    with get_connection() as conn:
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT
                directory_path,
                COUNT(*) AS total_count,
                SUM(CASE WHEN rating = 0 THEN 1 ELSE 0 END) AS unrated_count
            FROM photos
            WHERE (is_unlinked IS NULL OR is_unlinked = 0)
              AND NOT (is_raw = 1 AND paired_raw_path IS NOT NULL)
              AND directory_path IS NOT NULL AND directory_path != ''
            GROUP BY directory_path
            HAVING unrated_count > 0
            """
        )
        rows = cursor.fetchall()
        if not rows:
            return {"found": False, "total_unrated_folders": 0}

        chosen = random.choice(rows)
        folder_path = chosen["directory_path"]
        folder_name = os.path.basename(folder_path.rstrip("\\/")) or folder_path
        return {
            "found": True,
            "folder_path": folder_path,
            "folder_name": folder_name,
            "unrated_count": int(chosen["unrated_count"] or 0),
            "total_count": int(chosen["total_count"] or 0),
            "total_unrated_folders": len(rows),
        }
