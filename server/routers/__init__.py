"""
APIルーターパッケージ
server/app.py から機能ドメイン別のエンドポイント群を分割管理する。
"""

from . import (
    ai_router,
    export_import_router,
    gps_lab_router,
    mobile_router,
    security_router,
    storage_volumes_router,
)

ALL_ROUTERS = [
    ai_router.router,
    gps_lab_router.router,
    storage_volumes_router.router,
    export_import_router.router,
    mobile_router.router,
    security_router.router,
]

__all__ = [
    "ALL_ROUTERS",
    "ai_router",
    "export_import_router",
    "gps_lab_router",
    "mobile_router",
    "security_router",
    "storage_volumes_router",
]
