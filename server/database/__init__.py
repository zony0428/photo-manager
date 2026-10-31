"""
データベース管理パッケージ
写真のメタデータ（パス、EXIF撮影日時、カメラ機種、評価、タグなど）をSQLiteで永続化する。
評価は4段階: 棄(-1)・可(0)・良(1)・優(2)

後方互換性のため、すべての公開APIをこの __init__.py から再エクスポートする。
既存の `from .database import ...` / `from server.database import ...` は変更不要。
"""

# 定数・接続管理
from .connection import (
    CACHE_DIR,
    DB_PATH,
    _local_db,
    calc_solar_altitude,
    get_connection,
    close_thread_connection,
    switch_database_path,
)

# スキーマ・マイグレーション
from .schema import initialize_database

# 写真 CRUD・同期・GPS・ラボ分析
from .photos import (
    upsert_photo,
    upsert_photos_batch,
    get_existing_photos_map,
    get_photos,
    get_photo_by_id,
    get_photo_brief,
    get_photos_brief_batch,
    get_photo_by_path,
    get_total_photos_count,
    update_rating,
    batch_update_rating,
    delete_photo_by_id,
    delete_photos_by_ids,
    find_missing_photo_match,
    relink_photo_path,
    cleanup_missing_photos_in_folder,
    cleanup_missing_upload_photos,
    get_missing_photos,
    get_missing_photos_count,
    unlink_missing_photos_in_folder,
    get_unlinked_photos_count,
    purge_unlinked_photos,
    get_duplicate_photos_count,
    update_photo_gps,
    update_photo_adjustments,
    batch_update_photo_tone,
    batch_shift_photo_dates,
    invalidate_fast_cache,
    rotate_photo,
    reset_photo_adjustments,
    batch_reset_photo_adjustments,
    batch_rotate_photos,
    find_nearby_gps_photos,
    batch_copy_gps,
    batch_infer_gps,
    clear_inferred_gps,
    clear_photo_gps,
    cleanup_invalid_zero_gps,
    backfill_photo_locations,
    backfill_missing_lens_models,
    get_location_tree_summary,
)

# ラボ分析・ジオタグヒートマップ・撮影統計カルテ
from .lab_analytics import (
    get_location_heatmap_data,
    get_lab_karte_data,
    get_random_unrated_folder,
)

# タグ管理
from .tags import (
    COLOR_TAG_NAMES,
    is_color_tag,
    get_tag_key_map,
    get_key_to_tag_map,
    resolve_tag_by_key_or_name,
    update_tag_metadata,
    add_tag_to_photo,
    remove_tag_from_photo,
    batch_add_tag,
    batch_remove_tag,
    create_tag_definition,
    get_all_tags_summary,
    delete_tag,
    rename_tag,
    get_untagged_count,
    add_ai_tags_to_photo,
    promote_ai_tag,
    remove_ai_tags,
    get_photo_tags_details,
)

# サムネイル BLOB 管理
from .thumbnails import (
    compute_thumbnail_hash,
    save_thumbnail,
    save_thumbnails_batch,
    get_thumbnail,
    get_thumbnails_batch,
    delete_thumbnail,
    thumbnail_exists,
    find_existing_thumbnail_for_duplicate,
    clone_thumbnail,
)

# 重複写真スマート管理
from .duplicates import (
    compute_photo_quality_score,
    find_duplicate_photo_match,
    get_all_duplicate_groups,
    copy_metadata_to_duplicate,
    get_duplicates_for_photo,
    get_duplicate_photo_ids,
)

# スタック計算
from .stacks import recalculate_stacks, recalculate_duplicate_stacks, set_stack_primary

# フォルダ・タイムライン・カメラ集計・スキャンルート・ボリューム・除外フォルダ
from .folders import (
    upsert_volume,
    get_volume_by_serial,
    get_all_volumes,
    get_timeline_summary,
    get_calendar_summary,
    get_folders_summary,
    get_scan_roots_summary,
    get_cameras_summary,
    remove_folder_photos,
    add_scan_root,
    remove_scan_root,
    get_scan_roots,
    add_ignored_folder,
    remove_ignored_folder,
    get_ignored_folders,
    is_folder_ignored,
    get_drive_photo_counts,
    get_directory_counts_under,
    SYSTEM_IGNORE_NAMES,
)


# フォルダ指紋
from .fingerprint import (
    FINGERPRINT_EXTENSIONS,
    extract_folder_fingerprint,
    verify_folder_fingerprint,
    get_scan_root_fingerprint,
    update_scan_root_fingerprint,
)

# DB統計・メンテナンス・バックアップ
from .stats import (
    format_bytes,
    get_database_stats,
    vacuum_database,
    backup_database,
    get_backup_info,
    open_backup_directory,
)

# フィルタプリセット管理
from .presets import (
    get_filter_presets,
    get_filter_preset,
    create_filter_preset,
    update_filter_preset,
    delete_filter_preset,
)
