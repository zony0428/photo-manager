"""
3段階セキュリティ（Lv.0 エシカル / Lv.1 起動＆DBロック / Lv.2 フルロック）＆ 鍵サルベージ APIルーター
"""

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..database.folders import clear_folders_fs_cache
from ..scanner import clear_online_cache
from ..security import (
    configure_security_level,
    get_security_status,
    lock_session_now,
    recover_db_by_owned_media,
    unlock_foreign_loome_with_password,
    unlock_with_password_or_recovery,
)
from ..storage_manager import invalidate_loome_roots_cache
from .common import clear_api_photos_cache

router = APIRouter()


# ==============================================================================
# 3段階セキュリティ（Lv.0 エシカル / Lv.1 起動＆DBロック / Lv.2 フルロック）API
# ==============================================================================


class SecurityUnlockRequest(BaseModel):
    password: str


class SecurityConfigureRequest(BaseModel):
    target_level: int
    current_password: Optional[str] = None
    new_password: Optional[str] = None


class SecurityRecoverDbRequest(BaseModel):
    mode: str = "owned_media"  # "owned_media" | "password" | "recovery_code"
    secret: Optional[str] = None


class SecurityUnlockForeignLoomeRequest(BaseModel):
    volume_serial: str
    password: str


@router.get("/api/security/status")
def api_get_security_status():
    """現在のセキュリティ設定レベル・ロック状態・DB引き抜き検知状態を取得する"""
    return get_security_status()


@router.post("/api/security/unlock")
def api_security_unlock(req: SecurityUnlockRequest):
    """パスワードまたはリカバリーコードでアプリロック（またはDB引き継ぎロック）を解除する"""
    try:
        res = unlock_with_password_or_recovery(req.password)
        clear_online_cache()
        clear_folders_fs_cache()
        invalidate_loome_roots_cache()
        clear_api_photos_cache()
        return res
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/security/lock")
def api_security_lock():
    """現在のセッションを即座にロック状態へ戻す（Lv.1 / Lv.2 設定時）"""
    try:
        res = lock_session_now()
        clear_api_photos_cache()
        return res
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/security/configure")
def api_security_configure(req: SecurityConfigureRequest):
    """セキュリティレベル（Lv.0 / Lv.1 / Lv.2）およびパスワードを設定・変更する"""
    try:
        res = configure_security_level(
            target_level=req.target_level,
            current_password=req.current_password,
            new_password=req.new_password,
        )
        clear_online_cache()
        clear_folders_fs_cache()
        invalidate_loome_roots_cache()
        clear_api_photos_cache()
        return res
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/security/recover-db")
def api_security_recover_db(req: SecurityRecoverDbRequest):
    """
    USB故障・新環境移行時に、バックアップされた library.db を正当なオーナーとして引き継ぐ。
    - mode="owned_media": 接続中の所有ドライブ（VSN＋実在写真ファイル）照合により救済（Lv.0用）
    - mode="password" / "recovery_code": パスワードまたはリカバリーコードにより救済
    """
    try:
        mode_norm = (req.mode or "owned_media").strip().lower()
        if mode_norm == "owned_media":
            res = recover_db_by_owned_media()
        else:
            res = unlock_with_password_or_recovery(req.secret or "")
        clear_online_cache()
        clear_folders_fs_cache()
        invalidate_loome_roots_cache()
        clear_api_photos_cache()
        return res
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/security/unlock-foreign-loome")
def api_security_unlock_foreign_loome(req: SecurityUnlockForeignLoomeRequest):
    """別環境のTetheractでパスワード設定された自分の外付け Loome を、同じパスワードの入力により承認する"""
    try:
        res = unlock_foreign_loome_with_password(req.volume_serial, req.password)
        clear_online_cache()
        clear_folders_fs_cache()
        invalidate_loome_roots_cache()
        clear_api_photos_cache()
        return res
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
