"""
ルーター間で共有する定数・キャッシュ・ヘルパー関数定義
"""

import json
from pathlib import Path
from typing import Any, Dict, Tuple

from fastapi import HTTPException, Request
from fastapi.responses import Response

from ..lan_access import is_loopback_client
from ..storage_manager import STORAGE_DIR

# プロジェクトルートディレクトリ
BASE_DIR = Path(__file__).resolve().parent.parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"
UPLOAD_DIR = STORAGE_DIR
IMPORT_DIR = BASE_DIR / "take_out"
IMPORT_DIR.mkdir(parents=True, exist_ok=True)

# モバイルからのWi-Fi直接同期イベント通知用カウンタ（PC画面の自動リロード連動用）
_mobile_sync_event: Dict[str, int] = {"seq": 0, "applied_count": 0}

# 写真一覧APIのオンメモリレスポンスキャッシュ
_API_PHOTOS_RESPONSE_CACHE: Dict[Tuple, Tuple[float, Response]] = {}


def clear_api_photos_cache() -> None:
    """写真一覧APIのレスポンスキャッシュをクリアする"""
    _API_PHOTOS_RESPONSE_CACHE.clear()


def _fast_json(obj: Any, status_code: int = 200) -> Response:
    """FastAPI標準のjsonable_encoderを回避し、json.dumpsで高速にJSONレスポンスを生成する"""
    return Response(
        content=json.dumps(obj, ensure_ascii=False, separators=(",", ":"), default=str),
        status_code=status_code,
        media_type="application/json",
    )


def _require_localhost(request: Request) -> None:
    """ローカルホストからのアクセスのみ許可する（二重ガード）"""
    client_host = request.client.host if request.client else ""
    if not is_loopback_client(client_host):
        raise HTTPException(status_code=403, detail="この操作はPC本体（localhost）からのみ実行できます。")
