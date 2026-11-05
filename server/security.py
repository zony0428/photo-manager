"""
Tetheract Photo Manager - 3段階セキュリティ＆エシカル保護モジュール

【3段階セキュリティモデル】
- Lv.0: エシカルモード (Ethical Mode / 既定・常時有効・パスワード不要)
  1. 他人の Loome が存在するドライブの完全拒否（閲覧不可・ドライブ全体の管理登録不可・Loome上書き作成不可）
  2. library.db 単体の引き抜き・別環境への差し替え検知ロック（本体個体鍵 .tetheract_instance ペアリング）
  3. 本体USB故障時の3つの救済手段（①パスワード、②所有メディアVSN＋実写真照合、③リカバリーコード）
- Lv.1: 起動ロック ＆ DBロックモード (パスワード必要)
  - Lv.0 の全保護に加え、アプリ起動時のパスワードロック画面（API遮断）
  - 2段階キー方式（DEK + PBKDF2-HMAC-SHA256 KEK）による DB 内サムネイル BLOB の暗号化＋VACUUM平文消去
- Lv.2: フルロックモード (Lv.1 ＋ Loome カプセル化ロック・パスワード必要)
  - Lv.1 の全保護に加え、Loome（本体および外付け）内の画像・RAWファイルの先頭64KBをインプレース暗号化し、
    Windowsエクスプローラーや外部ソフトからの直接閲覧を遮断。
  - Tetheract 解錠中はオンメモリで透過的に復号表示し、スマート・テイクアウトや外部エクスポート時には元の無加工ファイルへ完全復元する。
"""

import contextlib
import hashlib
import hmac
import io
import json
import logging
import os
import secrets
import shutil
import sqlite3
import struct
import tempfile
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple, Union

logger = logging.getLogger("photo_manager.security")

PROJECT_ROOT = Path(__file__).resolve().parent.parent
INSTANCE_FILE = PROJECT_ROOT / ".tetheract_instance"
LOOME_SEAL_FILENAME = ".loome_seal"

# サムネイルBLOB暗号化ヘッダ: magic(5B) + nonce(16B) + mac(32B) = 53 bytes
THUMB_ENC_MAGIC = b"TENC\x01"
THUMB_ENC_HEADER_SIZE = 53
THUMB_AAD = b"TETH_THUMB_V1"

# Lv.2 Loome ファイルカプセル化定数
# 先頭 8B を VAULT_MAGIC に置換、先頭最大 64KB をストリーム暗号化
# 末尾 72B フッター: cipher_head8(8B) + nonce(16B) + mac(32B) + orig_mtime_ns(8B) + VAULT_MAGIC(8B)
VAULT_MAGIC = b"TETHVLT1"
VAULT_FILE_MAGIC = VAULT_MAGIC
VAULT_CHUNK_SIZE = 65536
VAULT_FOOTER_SIZE = 72

PBKDF2_ITERATIONS = 200_000
RECOVERY_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

# スレッドセーフなランタイムセキュリティ状態
_sec_lock = threading.RLock()
_runtime_state: Dict[str, Any] = {
    "initialized": False,
    "db_path": None,
    "security_level": 0,          # 0: エシカル, 1: 起動&DBロック, 2: フルロック
    "is_locked": False,           # Lv.1/Lv.2 の起動パスワード未入力ロック中か
    "db_foreign_locked": False,   # library.db 単体引き抜き検知ロック中か
    "has_password": False,        # パスワードラップが設定済みか
    "owner_id": "",
    "owner_secret": b"",
    "dek": b"",                   # 32-byte Data Encryption Key (アンロック中のみメモリ保持)
    "fallback_deks": [],          # 過去環境や旧シールから復元した予備DEKリスト (bytes)
    "recovery_code": "",          # アンロック中のみメモリ保持
    "active_password_hash": b"",  # 同一セッション内で自分の外付けLoomeを自動承認するためのハッシュ
    "approved_foreign_vsns": set(),
}

# 外付けドライブの Loome 所有権判定キャッシュ: key=(drive_root_upper, vsn, owner_id) -> (monotonic_ts, status, detail_dict)
_drive_loome_cache: Dict[Tuple[str, str, str], Tuple[float, str, Dict[str, Any]]] = {}
_DRIVE_LOOME_CACHE_TTL = 4.0


# ==============================================================================
# 1. 基本暗号プリミティブ (標準ライブラリ OpenSSL C実装: PBKDF2 + SHAKE256 + HMAC-SHA256)
# ==============================================================================

def _xor_bytes(data: bytes, keystream: bytes) -> bytes:
    """2つのバイト列をC実装の多倍長整数XORで高速に合成する"""
    n = len(data)
    if n == 0:
        return b""
    return (int.from_bytes(data, "big") ^ int.from_bytes(keystream[:n], "big")).to_bytes(n, "big")


def derive_kek(password: str, salt: bytes, iterations: int = PBKDF2_ITERATIONS) -> bytes:
    """パスワードとソルトから PBKDF2-HMAC-SHA256 で 256-bit (32 bytes) の KEK を導出する"""
    pw_bytes = (password or "").encode("utf-8")
    return hashlib.pbkdf2_hmac("sha256", pw_bytes, salt, iterations, dklen=32)


def aead_encrypt(key: bytes, plaintext: bytes, aad: bytes = b"") -> bytes:
    """
    256-bit キーを用いてバイト列を認証付き暗号化 (Encrypt-then-MAC: SHAKE256 + HMAC-SHA256) する。
    出力形式: THUMB_ENC_MAGIC(5B) + nonce(16B) + mac(32B) + ciphertext
    """
    if len(key) != 32:
        raise ValueError("暗号化キーは32バイトである必要があります")
    nonce = secrets.token_bytes(16)
    ks = hashlib.shake_256(key + nonce + b"TETH_ENC_V1").digest(len(plaintext))
    ciphertext = _xor_bytes(plaintext, ks)
    mac_key = hashlib.shake_256(key + nonce + b"TETH_MAC_V1").digest(32)
    mac = hmac.digest(mac_key, THUMB_ENC_MAGIC + nonce + aad + ciphertext, "sha256")
    return THUMB_ENC_MAGIC + nonce + mac + ciphertext


def aead_decrypt(key: bytes, blob: bytes, aad: bytes = b"") -> bytes:
    """aead_encrypt で暗号化されたバイト列を検証・復号する（改ざん・キー不一致時は ValueError）"""
    if len(key) != 32:
        raise ValueError("復号キーは32バイトである必要があります")
    if not blob or len(blob) < THUMB_ENC_HEADER_SIZE or blob[:5] != THUMB_ENC_MAGIC:
        raise ValueError("暗号化フォーマットが不正です")
    nonce = blob[5:21]
    mac = blob[21:53]
    ciphertext = blob[53:]
    mac_key = hashlib.shake_256(key + nonce + b"TETH_MAC_V1").digest(32)
    expected_mac = hmac.digest(mac_key, THUMB_ENC_MAGIC + nonce + aad + ciphertext, "sha256")
    if not hmac.compare_digest(mac, expected_mac):
        raise ValueError("暗号データの認証に失敗しました（パスワードまたはキーが一致しません）")
    ks = hashlib.shake_256(key + nonce + b"TETH_ENC_V1").digest(len(ciphertext))
    return _xor_bytes(ciphertext, ks)


def is_encrypted_blob(blob: Optional[bytes]) -> bool:
    """バイト列が Tetheract の AEAD 暗号化 BLOB かどうかを判定する"""
    return bool(blob and len(blob) >= THUMB_ENC_HEADER_SIZE and blob[:5] == THUMB_ENC_MAGIC)


def encrypt_thumbnail_blob(dek: bytes, raw_data: bytes, photo_id: Optional[int] = None) -> bytes:
    """
    サムネイルBLOBを固定AAD (THUMB_AAD) で暗号化する。
    重複統合やLoomeインポート等で photo_id が付け替わっても復号エラーにならないよう固定AADを使用する。
    """
    if not raw_data or is_encrypted_blob(raw_data):
        return raw_data
    return aead_encrypt(dek, raw_data, aad=THUMB_AAD)


def decrypt_thumbnail_blob(dek: bytes, blob: bytes, photo_id: Optional[int] = None) -> bytes:
    """
    暗号化されたサムネイルBLOBを復号する。
    固定AAD (THUMB_AAD) -> 旧photo_idベースAAD -> 空AAD の順で試行し、重複統合後のデータや旧形式にも完全対応する。
    """
    if not blob or not is_encrypted_blob(blob):
        return blob
    candidate_aads = [THUMB_AAD]
    if photo_id is not None:
        candidate_aads.append(str(photo_id).encode("utf-8"))
    candidate_aads.append(b"")
    last_err: Optional[Exception] = None
    for aad in candidate_aads:
        try:
            return aead_decrypt(dek, blob, aad=aad)
        except Exception as e:
            last_err = e
    if last_err:
        raise last_err
    raise ValueError("サムネイルの復号に失敗しました")


def generate_recovery_code() -> str:
    """人間が読み書きしやすい 16文字（4文字×4ブロック）のリカバリーコードを生成する"""
    blocks = []
    for _ in range(4):
        block = "".join(secrets.choice(RECOVERY_ALPHABET) for _ in range(4))
        blocks.append(block)
    return "TETH-" + "-".join(blocks)


def normalize_recovery_code(code: str) -> str:
    """入力されたリカバリーコードのハイフン・空白・大小文字揺れを正規化する"""
    cleaned = "".join(ch for ch in (code or "").upper().strip() if ch.isalnum())
    if cleaned.startswith("TETH"):
        cleaned = cleaned[4:]
    return cleaned


# ==============================================================================
# 2. 本体個体鍵 (.tetheract_instance) 管理
# ==============================================================================

_custom_instance_file: Optional[Path] = None


def set_instance_file_for_test(path: Optional[Path]) -> None:
    """自動テスト用: 本体個体鍵ファイルのパスを切り替える"""
    global _custom_instance_file
    with _sec_lock:
        _custom_instance_file = path
        _runtime_state["initialized"] = False


def get_instance_file_path() -> Path:
    """現在有効な本体個体鍵ファイルのパスを返す（テストDB使用時はテストフォルダ内に隔離）"""
    if _custom_instance_file is not None:
        return _custom_instance_file
    active_root = _get_active_project_root()
    if active_root != PROJECT_ROOT:
        return active_root / ".tetheract_instance"
    return INSTANCE_FILE


def _get_active_project_root() -> Path:
    """現在有効なプロジェクトルート（テスト環境ではカスタム個体鍵またはテストDBの親フォルダ）を返す"""
    if _custom_instance_file is not None:
        return _custom_instance_file.parent
    try:
        from .database.connection import DB_PATH
        db_p = Path(DB_PATH).resolve()
        proj_p = PROJECT_ROOT.resolve()
        try:
            db_p.relative_to(proj_p)
            return PROJECT_ROOT
        except ValueError:
            # テスト等で DB_PATH がプロジェクト外のテンポラリフォルダに切り替えられている場合
            return db_p.parent.parent if db_p.parent.name.lower() == "cache" else db_p.parent
    except Exception:
        return PROJECT_ROOT


def _get_internal_loome_dirs() -> List[Path]:
    """本体フォルダ内の Loome / storage ディレクトリ候補のうち実在するものを返す"""
    root = _get_active_project_root()
    candidates: List[Path] = []
    for sub in ("Loome", "storage"):
        p = root / sub
        if p.exists() and p.is_dir() and p not in candidates:
            candidates.append(p)
    if _custom_instance_file is None and root == PROJECT_ROOT:
        try:
            from .storage_manager import STORAGE_DIR
            if STORAGE_DIR.exists() and STORAGE_DIR.is_dir() and STORAGE_DIR not in candidates:
                candidates.append(STORAGE_DIR)
        except Exception:
            pass
    return candidates


def _derive_loome_cohesion_key(owner_id: str, seal_mac: str) -> bytes:
    """Lv.0 で cache/ と Loome/ がセットで新フォルダへ引っ越しされた際の自動ペアリング用キーを導出する"""
    raw = f"{owner_id}:{seal_mac}:LOOME_COHESION_LV0_V1".encode("utf-8")
    return hashlib.sha256(raw).digest()


def get_or_create_instance_identity() -> Dict[str, str]:
    """
    Tetheract 本体フォルダ固有の個体識別情報 (instance_id, instance_secret) を取得・自動生成する。
    cache/ の外に保持することで、library.db だけが別環境へ引き抜かれたことを検知する。
    """
    inst_path = get_instance_file_path()
    if inst_path.exists():
        try:
            with open(inst_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if (
                isinstance(data, dict)
                and len(str(data.get("instance_id", ""))) == 32
                and len(str(data.get("instance_secret", ""))) == 64
            ):
                return {
                    "instance_id": str(data["instance_id"]),
                    "instance_secret": str(data["instance_secret"]),
                }
        except Exception as e:
            logger.warning(f"個体鍵ファイルの読み取り失敗、再生成します ({inst_path}): {e}")

    identity = {
        "instance_id": secrets.token_hex(16),
        "instance_secret": secrets.token_hex(32),
        "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    }
    try:
        inst_path.parent.mkdir(parents=True, exist_ok=True)
        with open(inst_path, "w", encoding="utf-8") as f:
            json.dump(identity, f, ensure_ascii=False, indent=2)
        # Windows環境ではドット始まりファイルに隠し属性も付与（失敗しても無視）
        if os.name == "nt":
            try:
                import ctypes
                ctypes.windll.kernel32.SetFileAttributesW(str(inst_path), 0x02)
            except Exception as attr_err:
                logger.debug(f"個体鍵ファイルの隠し属性設定スキップ: {attr_err}")
    except Exception as e:
        logger.warning(f"個体鍵ファイルの保存失敗 ({inst_path}): {e}")

    return {
        "instance_id": identity["instance_id"],
        "instance_secret": identity["instance_secret"],
    }


def _derive_instance_wrap_key(instance_secret_hex: str, owner_id: str) -> bytes:
    """本体個体シークレットと DB の owner_id から 32バイトのローカルラップキーを導出する"""
    raw = bytes.fromhex(instance_secret_hex) + (owner_id or "").encode("utf-8") + b"INSTANCE_WRAP_V1"
    return hashlib.sha256(raw).digest()


def _derive_vsn_wrap_key(vsn: str, owner_id: str) -> bytes:
    """所有メディアの VSN と owner_id から Lv.0 救済用のラップキーを導出する"""
    clean_vsn = (vsn or "").strip().upper()
    raw = f"{clean_vsn}:{owner_id}:VSN_RESCUE_V1".encode("utf-8")
    return hashlib.sha256(raw).digest()


# ==============================================================================
# 3. データベース security_meta テーブルと起動・ペアリング管理
# ==============================================================================

def ensure_security_table(conn: sqlite3.Connection) -> None:
    """security_meta テーブルが存在しない場合は作成する"""
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS security_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
        """
    )


def _get_meta_map(conn: sqlite3.Connection) -> Dict[str, str]:
    ensure_security_table(conn)
    cur = conn.cursor()
    cur.execute("SELECT key, value FROM security_meta")
    return {str(row["key"]): str(row["value"]) for row in cur.fetchall()}


def _set_meta_values(conn: sqlite3.Connection, updates: Dict[str, str]) -> None:
    ensure_security_table(conn)
    cur = conn.cursor()
    for k, v in updates.items():
        cur.execute(
            "INSERT INTO security_meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (str(k), str(v)),
        )


# Google Drive for Desktop 等の全PC・全アカウント共通の仮想ボリュームシリアル番号は、
# 個体識別・物理メディア救済キーの対象から除外する
SHARED_VIRTUAL_VSNS = {"19831116", "00000000", "FFFFFFFF"}


def _collect_known_db_vsns(conn: sqlite3.Connection) -> List[str]:
    """DB内の volumes および photos テーブルに記録されている既知の物理ボリュームシリアル番号一覧を返す"""
    vsns = set()
    cur = conn.cursor()
    try:
        cur.execute("SELECT volume_serial FROM volumes WHERE volume_serial IS NOT NULL AND volume_serial != ''")
        for r in cur.fetchall():
            v = str(r[0]).strip().upper()
            if v and v not in SHARED_VIRTUAL_VSNS:
                vsns.add(v)
    except Exception as e:
        logger.debug(f"volumes VSN収集スキップ: {e}")

    try:
        cur.execute("SELECT DISTINCT volume_serial FROM photos WHERE volume_serial IS NOT NULL AND volume_serial != '' LIMIT 50")
        for r in cur.fetchall():
            v = str(r[0]).strip().upper()
            if v and v not in SHARED_VIRTUAL_VSNS:
                vsns.add(v)
    except Exception as e:
        logger.debug(f"photos VSN収集スキップ: {e}")

    try:
        cur.execute("SELECT DISTINCT volume_serial FROM photo_links WHERE volume_serial IS NOT NULL AND volume_serial != '' LIMIT 50")
        for r in cur.fetchall():
            v = str(r[0]).strip().upper()
            if v and v not in SHARED_VIRTUAL_VSNS:
                vsns.add(v)
    except Exception as e:
        logger.debug(f"photo_links VSN収集スキップ: {e}")

    return sorted(vsns)


def _build_vsn_rescue_bundles(conn: sqlite3.Connection, owner_id: str, bundle_bytes: bytes) -> str:
    """Lv.0 で本体USBが故障した際、所有ドライブVSN＋実写真照合で鍵を復旧できるよう既知VSNごとの暗号化バンドルを作成する"""
    vsns = _collect_known_db_vsns(conn)
    rescue_map: Dict[str, str] = {}
    for vsn in vsns:
        vkey = _derive_vsn_wrap_key(vsn, owner_id)
        rescue_map[vsn] = aead_encrypt(vkey, bundle_bytes, aad=owner_id.encode("utf-8")).hex()
    return json.dumps(rescue_map, ensure_ascii=False)


def save_recovery_key_file(recovery_code: str, owner_id: str, target_dir: Optional[Path] = None) -> Optional[Path]:
    """
    リカバリーコードをテキストファイルとして保存する。
    DBバックアップ実行時や初回生成時に cache/recovery_key.txt や cache/backups/ へ出力する。
    既存の recovery_key.txt に別オーナーIDや別コードの記録が存在する場合は上書き消去せず履歴として残す。
    """
    if not recovery_code:
        return None
    from .database.connection import DB_PATH
    out_dir = target_dir if target_dir is not None else Path(DB_PATH).parent
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / "recovery_key.txt"
        old_content = ""
        if out_path.exists():
            try:
                with open(out_path, "r", encoding="utf-8") as f:
                    old_content = f.read()
            except Exception:
                old_content = ""

        # 既に同一のリカバリーコードが先頭に記録されている場合はそのまま返す
        if old_content and f"復旧コード : {recovery_code}" in old_content.splitlines()[:10]:
            return out_path

        content = (
            "======================================================================\n"
            "  Tetheract Photo Manager - データベース復旧キー (Recovery Key)\n"
            "======================================================================\n"
            f"発行日時   : {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n"
            f"オーナーID : {owner_id}\n"
            f"復旧コード : {recovery_code}\n"
            "----------------------------------------------------------------------\n"
            "※ 本体入りUSBメモリの故障時や、パスワードを忘れた際に library.db を\n"
            "   新しい環境へ引き継ぐための重要な鍵です。安全な場所に保管してください。\n"
            "======================================================================\n"
        )
        if old_content.strip() and f"復旧コード : {recovery_code}" not in old_content:
            content += "\n\n# --- 過去の発行履歴 (自動保持) ---\n" + old_content.strip() + "\n"

        with open(out_path, "w", encoding="utf-8") as f:
            f.write(content)
        return out_path
    except Exception as e:
        logger.warning(f"リカバリーキーファイルの保存失敗 ({out_dir}): {e}")
        return None


def _try_salvage_meta_from_internal_loome_seal(conn: sqlite3.Connection) -> bool:
    """
    library.db が誤削除・再作成された際、本体フォルダ内の Loome/.loome_seal に残っている
    暗号化鍵メタデータ（owner_id, パスワードラップ, リカバリーコードラップ, 個体鍵ラップ）を
    新しい空の library.db の security_meta テーブルへ自動サルベージする（セルフブリック防止）。
    ※ 既に写真データが入っている未刻印DB（外部から放り込まれた旧バージョンDB等）に対しては、
       別オーナーの鍵を誤って上書きサルベージしないようスキップする。
    """
    try:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM photos")
        if int(cur.fetchone()[0] or 0) > 0:
            return False
    except Exception:
        pass

    for loome_dir in _get_internal_loome_dirs():
        seal_path = loome_dir / LOOME_SEAL_FILENAME
        if not seal_path.exists():
            continue
        try:
            with open(seal_path, "r", encoding="utf-8") as f:
                seal = json.load(f)
            if not isinstance(seal, dict):
                continue
            seal_owner = str(seal.get("owner_id") or "").strip()
            if not seal_owner:
                continue
            has_rec = bool(seal.get("recovery_salt") and seal.get("dek_wrapped_recovery"))
            has_pw = bool(seal.get("pw_salt") and seal.get("wrapped_owner_bundle"))
            bound_raw = seal.get("bound_instances")
            has_bound = bool(bound_raw and bound_raw != "{}")
            if not (has_rec or has_pw or has_bound):
                continue

            sec_level = int(seal.get("security_level", 1 if has_pw else 0) or 0)
            if isinstance(bound_raw, dict):
                bound_str = json.dumps(bound_raw, ensure_ascii=False)
            elif isinstance(bound_raw, str) and bound_raw.strip():
                bound_str = bound_raw
            else:
                bound_str = "{}"

            updates: Dict[str, str] = {
                "security_level": str(sec_level),
                "owner_id": seal_owner,
                "bound_instances": bound_str,
                "recovery_salt": str(seal.get("recovery_salt") or ""),
                "dek_wrapped_recovery": str(seal.get("dek_wrapped_recovery") or ""),
                "pw_salt": str(seal.get("pw_salt") or "") if has_pw else "",
                "dek_wrapped_pw": str(seal.get("wrapped_owner_bundle") or "") if has_pw else "",
                "vsn_rescue_bundles": "{}",
                "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            }
            _set_meta_values(conn, updates)
            conn.commit()
            logger.warning(
                f"library.db の再初期化を検知したため、本体 Loome ({seal_path}) からセキュリティ鍵メタデータ "
                f"(owner_id={seal_owner[:8]}..., Lv.{sec_level}) を自動サルベージしました。"
            )
            return True
        except Exception as e:
            logger.warning(f"本体 Loome からの鍵メタデータサルベージ試行エラー ({seal_path}): {e}")
    return False


def _is_unsealed_db_from_foreign_environment(conn: sqlite3.Connection) -> bool:
    """
    security_meta（owner_id）が未設定の既存DBが、
    「このPC自身の旧バージョンからの正当なアップグレードDB（またはポータブル運用DB）」なのか、
    「全く無関係な別PC環境で作られたDBが単体で放り込まれたもの（Foreign DB）」なのかを判定する。
    ※ 本体 Loome/.loome_seal の存在だけで別環境と判定すると、自身のバックアップDBを戻した際に
       誤ロックされるため、必ずDB内の実在パス・ドライブVSN・ホスト名の整合性で判定する。
    """
    import re
    import socket
    from urllib.parse import urlparse

    cur = conn.cursor()
    try:
        cur.execute("SELECT COUNT(*) FROM photos")
        photo_count = int(cur.fetchone()[0] or 0)
    except Exception:
        photo_count = 0

    if photo_count <= 0:
        return False

    # 1. ポータブルドライブ（C: 以外のUSBメモリ/外付けSSD等）上で稼働している場合は、
    #    複数PC間で持ち歩く正規のポータブル運用であるため常に正当なDBと判定する
    if _custom_instance_file is None:
        try:
            proj_drive = str(_get_active_project_root().resolve().drive or "").upper().rstrip("\\/")
            if proj_drive and proj_drive != "C:":
                return False
        except Exception:
            pass

    # 2. DB内の scan_roots または photos のディレクトリ・ファイルが現在の環境で1つでも実在すれば正当な自環境DB
    try:
        cur.execute("SELECT folder_path FROM scan_roots LIMIT 20")
        for r in cur.fetchall():
            fp = str(r[0] or "").strip()
            if fp and not fp.startswith("\\\\") and os.path.exists(fp):
                return False
    except Exception:
        pass

    try:
        cur.execute("SELECT file_path, directory_path FROM photos WHERE is_unlinked = 0 LIMIT 15")
        for r in cur.fetchall():
            fp = str(r[0] or "").strip()
            dp = str(r[1] or "").strip()
            if (fp and not fp.startswith("\\\\") and os.path.exists(fp)) or (
                dp and not dp.startswith("\\\\") and os.path.exists(dp)
            ):
                return False
    except Exception:
        pass

    # 3. app_meta.server_candidates に記録された作成元PCのホスト名と現在のホスト名を照合
    host_mismatch = False
    try:
        cur.execute("SELECT value FROM app_meta WHERE key = 'server_candidates'")
        row = cur.fetchone()
        if row and row[0]:
            candidates = json.loads(str(row[0]))
            if isinstance(candidates, list) and candidates:
                recorded_hosts = set()
                ip_re = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")
                for url_str in candidates:
                    parsed = urlparse(str(url_str))
                    h = (parsed.hostname or "").strip().lower()
                    if h and h not in ("localhost", "127.0.0.1", "::1") and not ip_re.match(h):
                        recorded_hosts.add(h.removesuffix(".local"))
                if recorded_hosts:
                    current_host = socket.gethostname().strip().lower().removesuffix(".local")
                    if current_host and current_host in recorded_hosts:
                        return False
                    if current_host and current_host not in recorded_hosts:
                        host_mismatch = True
    except Exception as e:
        logger.debug(f"app_meta ホスト名照合スキップ: {e}")

    # 4. volumes テーブルに記録された物理8桁HEX VSNと現PCの接続ドライブ VSN を照合
    try:
        hex8_re = re.compile(r"^[0-9A-F]{8}$")
        cur.execute("SELECT volume_serial, drive_letter FROM volumes WHERE volume_serial IS NOT NULL AND volume_serial != ''")
        vol_rows = cur.fetchall()
        recorded_physical_vsns = {}
        for vr in vol_rows:
            vsn_val = str(vr[0] or "").strip().upper()
            drv_val = str(vr[1] or "").strip().upper().rstrip("\\/")
            if hex8_re.match(vsn_val) and vsn_val not in SHARED_VIRTUAL_VSNS:
                recorded_physical_vsns[vsn_val] = drv_val

        if recorded_physical_vsns:
            from .scanner import _get_connected_drive_serial_map
            serial_to_drive, drive_to_serial = _get_connected_drive_serial_map()
            current_c_vsn = (drive_to_serial.get("C:") or "").strip().upper()

            # DB内の物理VSNが現PCの接続ドライブに1つでも存在すれば自環境DB
            if any(v in serial_to_drive for v in recorded_physical_vsns.keys()):
                return False

            # DB内の物理VSNが1つも接続されておらず、C: ドライブVSNまたはホスト名が不一致なら別環境DB
            for rec_vsn, rec_drv in recorded_physical_vsns.items():
                if rec_drv == "C:" and current_c_vsn and rec_vsn != current_c_vsn:
                    logger.warning(
                        f"DB内の C: ドライブ VSN ({rec_vsn}) が現PCの C: ドライブ VSN ({current_c_vsn}) と不一致かつ"
                        "管理ドライブが未接続のため、別環境DBの持ち込みと判定しました。"
                    )
                    return True

            if host_mismatch:
                logger.warning(
                    "DB内の記録ホスト名および物理ドライブ VSN が現PCと不一致のため、別環境DBの持ち込みと判定しました。"
                )
                return True
    except Exception as e:
        logger.debug(f"volumes VSN照合スキップ: {e}")

    return host_mismatch


def _try_auto_pair_lv0_by_internal_loome_seal(owner_id: str) -> Optional[bytes]:
    """
    Lv.0 でフル版ZIP等を新フォルダに展開し、cache/ と Loome/ をセットで手動コピペ引っ越しした際や、
    テスト等で別DBを読み込ませた後に元のDBへ戻した際、本体 Loome/.loome_seal（および previous_seals 履歴）の
    owner_id と Lv.0 コヒージョンバンドルが一致すれば正当なオーナーと判定してバンドルを復号返却する。
    """
    if not owner_id:
        return None
    for loome_dir in _get_internal_loome_dirs():
        seal_path = loome_dir / LOOME_SEAL_FILENAME
        if not seal_path.exists():
            continue
        try:
            with open(seal_path, "r", encoding="utf-8") as f:
                seal = json.load(f)
            if not isinstance(seal, dict):
                continue
            entries: List[Dict[str, Any]] = [seal]
            prev = seal.get("previous_seals")
            if isinstance(prev, list):
                entries.extend(p for p in prev if isinstance(p, dict))
            for entry in entries:
                if str(entry.get("owner_id") or "") != owner_id:
                    continue
                seal_mac = str(entry.get("seal_mac") or "")
                cohesion_hex = str(entry.get("lv0_cohesion_bundle") or "")
                if not seal_mac or not cohesion_hex:
                    continue
                try:
                    ckey = _derive_loome_cohesion_key(owner_id, seal_mac)
                    bundle_bytes = aead_decrypt(ckey, bytes.fromhex(cohesion_hex), aad=owner_id.encode("utf-8"))
                    bundle = json.loads(bundle_bytes.decode("utf-8"))
                    seal_vsn = str(entry.get("vsn") or "").strip().upper()
                    expected_mac = _compute_loome_seal_mac(bytes.fromhex(bundle["owner_secret"]), owner_id, seal_vsn)
                    if hmac.compare_digest(seal_mac, expected_mac):
                        return bundle_bytes
                except Exception:
                    continue
        except Exception as e:
            logger.debug(f"Lv.0 本体Loomeコヒージョン照合スキップ ({seal_path}): {e}")
    return None


def _try_auto_pair_lv0_by_local_recovery_file(meta: Dict[str, str]) -> Optional[bytes]:
    """
    同一環境の cache/recovery_key.txt（または cache/backups/recovery_key.txt）に
    当該DBの owner_id に対応するリカバリーコードが記録されている場合、それを復号して自動ペアリングする。
    （※ 自動テストで _custom_instance_file により別個体へのDB単体引き抜きをシミュレートしている場合はスキップ）
    """
    if _custom_instance_file is not None:
        return None
    owner_id = str(meta.get("owner_id") or "").strip()
    rec_salt_hex = str(meta.get("recovery_salt") or "").strip()
    wrapped_rec_hex = str(meta.get("dek_wrapped_recovery") or "").strip()
    if not (owner_id and rec_salt_hex and wrapped_rec_hex):
        return None

    from .database.connection import DB_PATH
    cache_dir = Path(DB_PATH).parent
    candidate_files = [
        cache_dir / "recovery_key.txt",
        cache_dir / "backups" / "recovery_key.txt",
    ]
    import re
    code_re = re.compile(r"TETH(?:-[2-9A-Z]{4}){4}")
    for rfile in candidate_files:
        if not rfile.exists():
            continue
        try:
            text = rfile.read_text(encoding="utf-8", errors="ignore")
            for match in code_re.findall(text):
                try:
                    rec_norm = normalize_recovery_code(match)
                    rec_kek = derive_kek(rec_norm, bytes.fromhex(rec_salt_hex))
                    return aead_decrypt(rec_kek, bytes.fromhex(wrapped_rec_hex), aad=owner_id.encode("utf-8"))
                except Exception:
                    continue
        except Exception:
            continue
    return None


def _sync_internal_loome_seals_if_unlocked() -> None:
    """アンロック状態のとき、本体フォルダ内の Loome/.loome_seal および recovery_key.txt を最新状態に同期する"""
    with _sec_lock:
        if is_app_locked() or not _runtime_state.get("owner_id") or not _runtime_state.get("owner_secret"):
            return
        rec_code = str(_runtime_state.get("recovery_code") or "")
        owner_id = str(_runtime_state.get("owner_id") or "")

    for loome_dir in _get_internal_loome_dirs():
        try:
            write_loome_seal(loome_dir)
        except Exception as e:
            logger.debug(f"本体Loomeシール自動同期スキップ ({loome_dir}): {e}")

    if rec_code and owner_id:
        try:
            from .database.connection import DB_PATH
            rec_file = Path(DB_PATH).parent / "recovery_key.txt"
            if not rec_file.exists():
                save_recovery_key_file(rec_code, owner_id)
        except Exception:
            pass


def initialize_security_state(force_reload: bool = False) -> Dict[str, Any]:
    """
    現在の DB_PATH に対してセキュリティメタデータを初期化・検証し、ランタイム状態を構築する。
    - 初回起動（未設定DB）の場合は、まず本体 Loome/.loome_seal に既存の鍵メタデータが残っていないか確認し、
      存在すれば自動サルベージする（Lv.2 運用中の DB 誤削除による鍵ロスト防止）。
    - 完全新規の場合は Lv.0（エシカルモード）として owner_id, DEK, リカバリーコードを発行し、現本体とペアリングする。
    - Lv.0 で別環境の library.db 単体が持ち込まれた場合（instance_id 不一致かつ本体 Loome 不一致）は db_foreign_locked = True にする。
    - Lv.1 / Lv.2 の場合は起動時 is_locked = True（パスワード入力待ち）にする。
    """
    from .database.connection import DB_PATH, get_connection

    with _sec_lock:
        if (
            _runtime_state["initialized"]
            and not force_reload
            and _runtime_state["db_path"] == str(DB_PATH)
        ):
            return get_security_status()

        inst = get_or_create_instance_identity()
        inst_id = inst["instance_id"]
        inst_secret = inst["instance_secret"]

        need_save_recovery_file: Optional[Tuple[str, str]] = None
        need_sync_internal_seals = False

        with get_connection() as conn:
            meta = _get_meta_map(conn)

            # 過去の誤判定で Lv.0 なのに bound_instances が空 "{}" で書き込まれてしまったDBの自動自己修復
            if meta.get("owner_id") and int(meta.get("security_level", "0") or 0) == 0:
                raw_bound = str(meta.get("bound_instances", "") or "").strip()
                if raw_bound in ("", "{}") and not _is_unsealed_db_from_foreign_environment(conn):
                    conn.execute("DELETE FROM security_meta")
                    conn.commit()
                    meta = {}

            # DBのsecurity_metaが空の場合、まず本体Loome/.loome_sealからの自動サルベージを試みる
            if not meta.get("owner_id"):
                if _try_salvage_meta_from_internal_loome_seal(conn):
                    meta = _get_meta_map(conn)

            if not meta.get("owner_id"):
                # 新規または既存DBへの初回セキュリティ初期化 (Lv.0: エシカルモード)
                is_foreign_unsealed = _is_unsealed_db_from_foreign_environment(conn)

                owner_id = secrets.token_hex(16)
                owner_secret = secrets.token_bytes(32)
                dek = secrets.token_bytes(32)
                recovery_code = generate_recovery_code()

                if is_foreign_unsealed:
                    # 別環境から単体で放り込まれた未刻印DBの場合は、元のDBファイルを汚染しないよう
                    # security_meta への永続書き込みは行わず、オンメモリのみロック状態にする
                    _runtime_state.update({
                        "initialized": True,
                        "db_path": str(DB_PATH),
                        "security_level": 0,
                        "is_locked": True,
                        "db_foreign_locked": True,
                        "has_password": False,
                        "owner_id": owner_id,
                        "owner_secret": b"",
                        "dek": b"",
                        "recovery_code": "",
                    })
                else:
                    bundle_plain = json.dumps({
                        "dek": dek.hex(),
                        "owner_secret": owner_secret.hex(),
                        "recovery_code": recovery_code,
                    }).encode("utf-8")

                    # 1. 本体個体鍵でラップ
                    inst_key = _derive_instance_wrap_key(inst_secret, owner_id)
                    wrapped_inst = aead_encrypt(inst_key, bundle_plain, aad=owner_id.encode("utf-8")).hex()
                    bound_instances = {inst_id: wrapped_inst}

                    # 2. リカバリーコードでラップ
                    rec_salt = secrets.token_bytes(16)
                    rec_norm = normalize_recovery_code(recovery_code)
                    rec_kek = derive_kek(rec_norm, rec_salt)
                    wrapped_rec = aead_encrypt(rec_kek, bundle_plain, aad=owner_id.encode("utf-8")).hex()

                    # 3. 既知ドライブVSNでの救済バンドル
                    vsn_bundles_json = _build_vsn_rescue_bundles(conn, owner_id, bundle_plain)

                    _set_meta_values(conn, {
                        "security_level": "0",
                        "owner_id": owner_id,
                        "bound_instances": json.dumps(bound_instances, ensure_ascii=False),
                        "recovery_salt": rec_salt.hex(),
                        "dek_wrapped_recovery": wrapped_rec,
                        "vsn_rescue_bundles": vsn_bundles_json,
                        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    })
                    conn.commit()

                    _runtime_state.update({
                        "initialized": True,
                        "db_path": str(DB_PATH),
                        "security_level": 0,
                        "is_locked": False,
                        "db_foreign_locked": False,
                        "has_password": False,
                        "owner_id": owner_id,
                        "owner_secret": owner_secret,
                        "dek": dek,
                        "recovery_code": recovery_code,
                    })
                    need_save_recovery_file = (recovery_code, owner_id)
                    need_sync_internal_seals = True
            else:
                # 既に初期化済みのDB
                owner_id = meta.get("owner_id", "")
                sec_level = int(meta.get("security_level", "0") or 0)
                has_pw = bool(meta.get("dek_wrapped_pw"))
                try:
                    bound_instances = json.loads(meta.get("bound_instances", "{}") or "{}")
                    if not isinstance(bound_instances, dict):
                        bound_instances = {}
                except Exception:
                    bound_instances = {}

                is_known_instance = inst_id in bound_instances

                if sec_level >= 1:
                    # Lv.1 / Lv.2: 起動時は常にパスワード入力ロック状態から開始する
                    _runtime_state.update({
                        "initialized": True,
                        "db_path": str(DB_PATH),
                        "security_level": sec_level,
                        "is_locked": True,
                        "db_foreign_locked": not is_known_instance,
                        "has_password": has_pw,
                        "owner_id": owner_id,
                        "owner_secret": b"",
                        "dek": b"",
                        "recovery_code": "",
                    })
                else:
                    # Lv.0 (エシカルモード)
                    unlocked_lv0 = False
                    bundle_bytes: Optional[bytes] = None
                    if is_known_instance:
                        wrapped_hex = bound_instances.get(inst_id, "")
                        try:
                            inst_key = _derive_instance_wrap_key(inst_secret, owner_id)
                            bundle_bytes = aead_decrypt(inst_key, bytes.fromhex(wrapped_hex), aad=owner_id.encode("utf-8"))
                        except Exception as e:
                            logger.warning(f"Lv.0 本体個体鍵によるバンドル復号失敗 ({e})")
                            bundle_bytes = None

                    # .tetheract_instance が新規（フル版ZIPへの cache/ + Loome/ 引っ越し等）の場合、
                    # 本体 Loome/.loome_seal または cache/recovery_key.txt で正当なオーナーかを検証して自動ペアリング
                    if bundle_bytes is None:
                        cohesion_bundle = _try_auto_pair_lv0_by_internal_loome_seal(owner_id)
                        if cohesion_bundle is None:
                            cohesion_bundle = _try_auto_pair_lv0_by_local_recovery_file(meta)
                        if cohesion_bundle is not None:
                            bundle_bytes = cohesion_bundle
                            _bind_current_instance_in_db(conn, owner_id, bundle_bytes, 0)
                            conn.commit()
                            logger.info("Lv.0 ローカルシールまたはリカバリーキーとの一致を確認したため、.tetheract_instance を自動ペアリングしました。")

                    if bundle_bytes is not None:
                        try:
                            bundle = json.loads(bundle_bytes.decode("utf-8"))
                            dek = bytes.fromhex(bundle["dek"])
                            owner_secret = bytes.fromhex(bundle["owner_secret"])
                            recovery_code = str(bundle.get("recovery_code", ""))

                            # 既知VSNが増えている場合は救済バンドルを最新化
                            new_vsn_bundles = _build_vsn_rescue_bundles(conn, owner_id, bundle_bytes)
                            if new_vsn_bundles != meta.get("vsn_rescue_bundles", ""):
                                _set_meta_values(conn, {"vsn_rescue_bundles": new_vsn_bundles})
                                conn.commit()

                            _runtime_state.update({
                                "initialized": True,
                                "db_path": str(DB_PATH),
                                "security_level": 0,
                                "is_locked": False,
                                "db_foreign_locked": False,
                                "has_password": has_pw,
                                "owner_id": owner_id,
                                "owner_secret": owner_secret,
                                "dek": dek,
                                "recovery_code": recovery_code,
                            })
                            unlocked_lv0 = True
                            need_sync_internal_seals = True
                        except Exception as e:
                            logger.warning(f"Lv.0 バンドル展開失敗 ({e}) -> 引き抜きロックへ移行")

                    if not unlocked_lv0:
                        # 未登録の本体環境に library.db だけが持ち込まれた場合 -> DB単体引き抜きロック発動！
                        _runtime_state.update({
                            "initialized": True,
                            "db_path": str(DB_PATH),
                            "security_level": 0,
                            "is_locked": True,
                            "db_foreign_locked": True,
                            "has_password": has_pw,
                            "owner_id": owner_id,
                            "owner_secret": b"",
                            "dek": b"",
                            "recovery_code": "",
                        })

        if need_save_recovery_file is not None:
            save_recovery_key_file(need_save_recovery_file[0], need_save_recovery_file[1])
        if need_sync_internal_seals:
            _sync_internal_loome_seals_if_unlocked()
        clear_drive_loome_cache()
        return get_security_status()


def refresh_vsn_rescue_bundles_if_unlocked() -> None:
    """新規ドライブスキャン後などに、Lv.0 の所有メディア救済バンドルを最新化する"""
    from .database.connection import get_connection
    with _sec_lock:
        if not _runtime_state["initialized"] or _runtime_state["is_locked"] or _runtime_state["db_foreign_locked"]:
            return
        if not _runtime_state["dek"] or not _runtime_state["owner_secret"]:
            return
        owner_id = _runtime_state["owner_id"]
        bundle_bytes = json.dumps({
            "dek": _runtime_state["dek"].hex(),
            "owner_secret": _runtime_state["owner_secret"].hex(),
            "recovery_code": _runtime_state["recovery_code"],
        }).encode("utf-8")
        try:
            with get_connection() as conn:
                new_vsn_bundles = _build_vsn_rescue_bundles(conn, owner_id, bundle_bytes)
                _set_meta_values(conn, {"vsn_rescue_bundles": new_vsn_bundles})
                conn.commit()
        except Exception as e:
            logger.debug(f"VSN救済バンドル更新スキップ: {e}")


def is_app_locked() -> bool:
    """現在アプリがロック中（パスワード入力待ち、またはDB単体引き抜きロック中）かを返す"""
    with _sec_lock:
        if not _runtime_state["initialized"]:
            initialize_security_state()
        return bool(_runtime_state["is_locked"] or _runtime_state["db_foreign_locked"])


def get_active_dek() -> Optional[bytes]:
    """アンロック中の DEK (32 bytes) を返す（未アンロック時は None）"""
    with _sec_lock:
        if not _runtime_state["initialized"]:
            initialize_security_state()
        dek = _runtime_state.get("dek")
        return dek if (dek and len(dek) == 32 and not is_app_locked()) else None


def get_current_security_level() -> int:
    """現在設定されているセキュリティレベル (0, 1, 2) を返す"""
    with _sec_lock:
        if not _runtime_state["initialized"]:
            initialize_security_state()
        return int(_runtime_state.get("security_level", 0))


def get_security_status() -> Dict[str, Any]:
    """フロントエンドおよびAPI向けのセキュリティ状態サマリーを返す"""
    from .database.connection import DB_PATH
    with _sec_lock:
        if not _runtime_state["initialized"] or _runtime_state["db_path"] != str(DB_PATH):
            initialize_security_state(force_reload=True)

        locked = bool(_runtime_state["is_locked"] or _runtime_state["db_foreign_locked"])
        level = int(_runtime_state["security_level"])
        owner_id = str(_runtime_state["owner_id"])
        rec_code = str(_runtime_state["recovery_code"]) if not locked else ""
        has_pw = bool(_runtime_state.get("has_password"))

        level_names = {
            0: "Lv.0: エシカルモード（標準保護）",
            1: "Lv.1: 起動ロック ＆ DBロックモード",
            2: "Lv.2: フルロックモード（Lv.1 ＋ Loomeカプセル化保護）",
        }
        return {
            "status": "ok",
            "security_level": level,
            "security_level_name": level_names.get(level, level_names[0]),
            "is_locked": locked,
            "password_locked": bool(_runtime_state["is_locked"] and level >= 1),
            "db_foreign_locked": bool(_runtime_state["db_foreign_locked"]),
            "has_password": has_pw,
            "owner_id": owner_id[:8] + "..." if owner_id else "",
            "owner_id_full": owner_id if not locked else "",
            "recovery_code": rec_code,
        }


def _bind_current_instance_in_db(conn: sqlite3.Connection, owner_id: str, bundle_bytes: bytes, sec_level: int) -> None:
    """現在の本体個体鍵 (.tetheract_instance) を DB の公認インスタンスリストに登録する"""
    inst = get_or_create_instance_identity()
    inst_id = inst["instance_id"]
    inst_secret = inst["instance_secret"]

    meta = _get_meta_map(conn)
    try:
        bound_instances = json.loads(meta.get("bound_instances", "{}") or "{}")
        if not isinstance(bound_instances, dict):
            bound_instances = {}
    except Exception:
        bound_instances = {}

    if sec_level == 0:
        inst_key = _derive_instance_wrap_key(inst_secret, owner_id)
        bound_instances[inst_id] = aead_encrypt(inst_key, bundle_bytes, aad=owner_id.encode("utf-8")).hex()
    else:
        # Lv.1 / Lv.2 では本体ファイルに DEK を残さず、ペアリング済みマーカーのみ記録する
        bound_instances[inst_id] = "PAIRED_PW_MODE"

    _set_meta_values(conn, {
        "bound_instances": json.dumps(bound_instances, ensure_ascii=False),
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    })


def unlock_with_password_or_recovery(secret_input: str) -> Dict[str, Any]:
    """
    パスワードまたはリカバリーコードを用いて起動ロック（およびDB引き継ぎロック）を解除する。
    """
    from .database.connection import get_connection

    candidate = (secret_input or "").strip()
    if not candidate:
        raise ValueError("パスワードまたはリカバリーコードを入力してください。")

    with _sec_lock:
        if not _runtime_state["initialized"]:
            initialize_security_state()

        with get_connection() as conn:
            meta = _get_meta_map(conn)
            owner_id = meta.get("owner_id", "")
            sec_level = int(meta.get("security_level", "0") or 0)

            bundle_bytes: Optional[bytes] = None
            used_password = False

            # 1. パスワードでの復号を試行
            pw_salt_hex = meta.get("pw_salt", "")
            wrapped_pw_hex = meta.get("dek_wrapped_pw", "")
            if pw_salt_hex and wrapped_pw_hex:
                try:
                    pw_kek = derive_kek(candidate, bytes.fromhex(pw_salt_hex))
                    bundle_bytes = aead_decrypt(pw_kek, bytes.fromhex(wrapped_pw_hex), aad=owner_id.encode("utf-8"))
                    used_password = True
                except Exception:
                    bundle_bytes = None

            # 2. リカバリーコードでの復号を試行
            if bundle_bytes is None:
                rec_salt_hex = meta.get("recovery_salt", "")
                wrapped_rec_hex = meta.get("dek_wrapped_recovery", "")
                if rec_salt_hex and wrapped_rec_hex:
                    try:
                        rec_norm = normalize_recovery_code(candidate)
                        rec_kek = derive_kek(rec_norm, bytes.fromhex(rec_salt_hex))
                        bundle_bytes = aead_decrypt(rec_kek, bytes.fromhex(wrapped_rec_hex), aad=owner_id.encode("utf-8"))
                    except Exception:
                        bundle_bytes = None

            if bundle_bytes is None:
                raise ValueError("パスワードまたはリカバリーコードが正しくありません。")

            bundle = json.loads(bundle_bytes.decode("utf-8"))
            dek = bytes.fromhex(bundle["dek"])
            owner_secret = bytes.fromhex(bundle["owner_secret"])
            recovery_code = str(bundle.get("recovery_code", ""))

            # 正当なオーナーとして現本体インスタンスをペアリング登録
            _bind_current_instance_in_db(conn, owner_id, bundle_bytes, sec_level)
            if sec_level == 0:
                new_vsn_bundles = _build_vsn_rescue_bundles(conn, owner_id, bundle_bytes)
                _set_meta_values(conn, {"vsn_rescue_bundles": new_vsn_bundles})
            conn.commit()

            _runtime_state.update({
                "is_locked": False,
                "db_foreign_locked": False,
                "owner_id": owner_id,
                "owner_secret": owner_secret,
                "dek": dek,
                "recovery_code": recovery_code,
                "active_password_hash": hashlib.sha256(candidate.encode("utf-8")).digest() if used_password else b"",
            })
            _sync_internal_loome_seals_if_unlocked()
            clear_drive_loome_cache()
            return get_security_status()


def recover_db_by_owned_media() -> Dict[str, Any]:
    """
    【救済手段②】本体入りUSBが故障し、Lv.0 のバックアップDBを新しい Tetheract 本体に入れた際、
    現在PCに接続されている所有メディア（内蔵ドライブやSDカード等の VSN）と、
    DBに記録されている実写真ファイル（ファイルパス・ファイルサイズ）の一致を検証して再ペアリングする。
    """
    from .database.connection import get_connection
    from .scanner import resolve_portable_path

    with _sec_lock:
        if not _runtime_state["initialized"]:
            initialize_security_state()

        with get_connection() as conn:
            meta = _get_meta_map(conn)
            owner_id = meta.get("owner_id", "")
            sec_level = int(meta.get("security_level", "0") or 0)
            if sec_level >= 1:
                raise ValueError("Lv.1 / Lv.2 で保護されたデータベースの引き継ぎには、パスワードまたはリカバリーコードが必要です。")

            try:
                rescue_map = json.loads(meta.get("vsn_rescue_bundles", "{}") or "{}")
            except Exception:
                rescue_map = {}

            if not rescue_map:
                raise ValueError("このデータベースには照合可能なメディア情報が記録されていません。リカバリーコードを使用してください。")

            cur = conn.cursor()
            verified_vsn: Optional[str] = None
            verified_count = 0

            for vsn, wrapped_hex in rescue_map.items():
                if str(vsn).strip().upper() in SHARED_VIRTUAL_VSNS:
                    continue
                cur.execute(
                    """
                    SELECT file_path, file_size FROM photos WHERE UPPER(volume_serial) = ?
                    UNION ALL
                    SELECT pl.file_path, p.file_size
                    FROM photo_links pl
                    JOIN photos p ON p.id = pl.photo_id
                    WHERE UPPER(pl.volume_serial) = ?
                    LIMIT 25
                    """,
                    (vsn.upper(), vsn.upper()),
                )
                rows = cur.fetchall()
                if not rows:
                    continue

                matched_files = 0
                for r in rows:
                    fpath_str = str(r["file_path"] or "")
                    expected_size = int(r["file_size"] or 0)
                    if not fpath_str or expected_size <= 0:
                        continue
                    real_p, is_online = resolve_portable_path(fpath_str, expected_serial=vsn)
                    if is_online and real_p.exists() and real_p.is_file():
                        try:
                            actual_size = get_logical_file_size(real_p)
                            if actual_size == expected_size:
                                matched_files += 1
                        except Exception:
                            continue

                required_matches = min(3, len(rows))
                if matched_files >= required_matches and matched_files > 0:
                    verified_vsn = vsn.upper()
                    verified_count = matched_files
                    break

            if not verified_vsn:
                raise ValueError(
                    "所有メディアの実写真照合に失敗しました。このデータベースで管理していた写真が保存されているドライブやSDカードをPCに接続してから再実行するか、リカバリーコードを入力してください。"
                )

            vkey = _derive_vsn_wrap_key(verified_vsn, owner_id)
            bundle_bytes = aead_decrypt(vkey, bytes.fromhex(rescue_map[verified_vsn]), aad=owner_id.encode("utf-8"))
            bundle = json.loads(bundle_bytes.decode("utf-8"))
            dek = bytes.fromhex(bundle["dek"])
            owner_secret = bytes.fromhex(bundle["owner_secret"])
            recovery_code = str(bundle.get("recovery_code", ""))

            _bind_current_instance_in_db(conn, owner_id, bundle_bytes, 0)
            conn.commit()

            _runtime_state.update({
                "is_locked": False,
                "db_foreign_locked": False,
                "owner_id": owner_id,
                "owner_secret": owner_secret,
                "dek": dek,
                "recovery_code": recovery_code,
            })
            _sync_internal_loome_seals_if_unlocked()
            clear_drive_loome_cache()
            status = get_security_status()
            status["verified_vsn"] = verified_vsn
            status["verified_photo_count"] = verified_count
            return status


# ==============================================================================
# 4. 外付け Loome の電子刻印 (.loome_seal) と「他人の Loome」完全拒否 (Lv.0 エシカル保護)
# ==============================================================================

def clear_drive_loome_cache() -> None:
    """外付けドライブの Loome 所有権判定キャッシュをクリアする"""
    with _sec_lock:
        _drive_loome_cache.clear()


def _compute_loome_seal_mac(owner_secret: bytes, owner_id: str, vsn: str) -> str:
    msg = f"{owner_id}:{(vsn or '').strip().upper()}:LOOME_SEAL_V1".encode("utf-8")
    return hmac.digest(owner_secret, msg, "sha256").hex()


def write_loome_seal(loome_dir: Path, volume_serial: Optional[str] = None, password: Optional[str] = None) -> bool:
    """
    自分の Loome フォルダ直下に電子刻印 (.loome_seal) を書き込む。
    - 別PCの自分の環境でもパスワードやリカバリーコードで承認・復号できるよう、
      パスワードラップとリカバリーコードラップの両方を格納する。
    - 万一 cache/library.db が誤削除された場合でも本体 Loome/.loome_seal から鍵一式をサルベージできるよう、
      security_level および bound_instances も格納し、さらに既存シールの別鍵情報があれば previous_seals に履歴退避する。
    """
    from .database.connection import get_connection
    from .volume_info import get_volume_info

    with _sec_lock:
        if not _runtime_state["initialized"]:
            initialize_security_state()
        if is_app_locked() or not _runtime_state["owner_id"] or not _runtime_state["owner_secret"]:
            return False

        owner_id = _runtime_state["owner_id"]
        owner_secret = _runtime_state["owner_secret"]
        dek = _runtime_state["dek"]
        recovery_code = str(_runtime_state.get("recovery_code") or "")

    try:
        loome_dir = Path(loome_dir)
        if not loome_dir.exists() or not loome_dir.is_dir():
            return False

        vsn = (volume_serial or "").strip().upper()
        if not vsn:
            vinfo = get_volume_info(str(loome_dir))
            vsn = (vinfo.get("serial") or "").strip().upper() if vinfo else ""

        seal_mac = _compute_loome_seal_mac(owner_secret, owner_id, vsn)
        bundle_plain = json.dumps({
            "dek": dek.hex(),
            "owner_secret": owner_secret.hex(),
            "recovery_code": recovery_code,
            "owner_id": owner_id,
        }).encode("utf-8")

        seal_data: Dict[str, Any] = {
            "version": 2,
            "owner_id": owner_id,
            "vsn": vsn,
            "seal_mac": seal_mac,
            "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }

        with get_connection() as conn:
            meta = _get_meta_map(conn)
            sec_level = int(meta.get("security_level", "0") or 0)
            seal_data["security_level"] = sec_level
            seal_data["bound_instances"] = meta.get("bound_instances", "{}")
            seal_data["recovery_salt"] = meta.get("recovery_salt", "")
            seal_data["dek_wrapped_recovery"] = meta.get("dek_wrapped_recovery", "")

            pw_salt_hex = meta.get("pw_salt", "")
            wrapped_pw_hex = meta.get("dek_wrapped_pw", "")
            if pw_salt_hex and wrapped_pw_hex:
                seal_data["pw_protected"] = True
                seal_data["pw_salt"] = pw_salt_hex
                seal_data["wrapped_owner_bundle"] = wrapped_pw_hex
            elif password:
                pw_salt = secrets.token_bytes(16)
                pw_kek = derive_kek(password, pw_salt)
                seal_data["pw_protected"] = True
                seal_data["pw_salt"] = pw_salt.hex()
                seal_data["wrapped_owner_bundle"] = aead_encrypt(pw_kek, bundle_plain, aad=owner_id.encode("utf-8")).hex()
            else:
                seal_data["pw_protected"] = False

            # Lv.0 の場合は、cache/ + Loome/ セット引っ越し時やポータブル起動時の自動ペアリング用バンドルを付与
            if sec_level == 0:
                ckey = _derive_loome_cohesion_key(owner_id, seal_mac)
                seal_data["lv0_cohesion_bundle"] = aead_encrypt(ckey, bundle_plain, aad=owner_id.encode("utf-8")).hex()

        seal_path = loome_dir / LOOME_SEAL_FILENAME
        # 既存の .loome_seal に異なる owner_id や異なるリカバリーラップが存在する場合は previous_seals に退避して絶対に消去しない
        previous_seals: List[Dict[str, Any]] = []
        if seal_path.exists():
            try:
                with open(seal_path, "r", encoding="utf-8") as f:
                    old_seal = json.load(f)
                if isinstance(old_seal, dict):
                    old_prev = old_seal.pop("previous_seals", [])
                    if isinstance(old_prev, list):
                        previous_seals.extend(p for p in old_prev if isinstance(p, dict))
                    old_owner = str(old_seal.get("owner_id") or "")
                    old_rec_wrap = str(old_seal.get("dek_wrapped_recovery") or "")
                    old_pw_wrap = str(old_seal.get("wrapped_owner_bundle") or "")
                    if old_owner and (
                        old_owner != owner_id
                        or (old_rec_wrap and old_rec_wrap != seal_data.get("dek_wrapped_recovery"))
                        or (old_pw_wrap and old_pw_wrap != seal_data.get("wrapped_owner_bundle"))
                    ):
                        previous_seals.insert(0, old_seal)
            except Exception:
                pass
        if previous_seals:
            seal_data["previous_seals"] = previous_seals[:10]

        # Windowsで既に隠し属性が付いている場合は一旦解除してから書き込む
        if os.name == "nt" and seal_path.exists():
            try:
                import ctypes
                ctypes.windll.kernel32.SetFileAttributesW(str(seal_path), 0x80)  # FILE_ATTRIBUTE_NORMAL
            except Exception:
                pass

        with open(seal_path, "w", encoding="utf-8") as f:
            json.dump(seal_data, f, ensure_ascii=False, indent=2)

        if os.name == "nt":
            try:
                import ctypes
                ctypes.windll.kernel32.SetFileAttributesW(str(seal_path), 0x02)  # FILE_ATTRIBUTE_HIDDEN
            except Exception:
                pass
        return True
    except Exception as e:
        logger.warning(f"Loome電子刻印の書き込み失敗 ({loome_dir}): {e}")
        return False


def _has_user_files_in_loome(loome_dir: Path) -> bool:
    """Loome フォルダ内に隠し管理ファイル以外の実ファイルまたはサブフォルダが存在するかを高速判定する"""
    try:
        with os.scandir(str(loome_dir)) as it:
            for entry in it:
                name_low = entry.name.lower()
                if name_low in (".loome_seal", "desktop.ini", "thumbs.db", ".ds_store"):
                    continue
                if entry.name.startswith("."):
                    continue
                return True
    except Exception as e:
        logger.debug(f"Loome内ファイル有無確認スキップ ({loome_dir}): {e}")
    return False


def _is_loome_registered_in_own_db(vsn: str, loome_dir: Path) -> bool:
    """指定 VSN または Loome パスが自DBに自分の Loome として登録履歴があるかを判定する（後方互換保護）"""
    from .database.connection import get_connection
    clean_vsn = (vsn or "").strip().upper()
    norm_loome = os.path.normpath(str(loome_dir)).rstrip("\\/")
    try:
        with get_connection() as conn:
            cur = conn.cursor()
            if clean_vsn:
                cur.execute(
                    "SELECT loome_enabled FROM volumes WHERE UPPER(volume_serial) = ? AND loome_enabled = 1",
                    (clean_vsn,),
                )
                if cur.fetchone():
                    return True
                cur.execute(
                    "SELECT 1 FROM photos WHERE UPPER(volume_serial) = ? AND (directory_path LIKE ? OR directory_path = ?) LIMIT 1",
                    (clean_vsn, norm_loome + "\\%", norm_loome),
                )
                if cur.fetchone():
                    return True
            cur.execute(
                "SELECT 1 FROM scan_roots WHERE LOWER(root_path) = LOWER(?) LIMIT 1",
                (norm_loome,),
            )
            if cur.fetchone():
                return True
    except Exception as e:
        logger.debug(f"自DB Loome登録履歴チェック失敗: {e}")
    return False


def inspect_drive_loome_ownership(
    drive_or_path: Union[str, Path],
    volume_serial: Optional[str] = None,
) -> Tuple[str, Dict[str, Any]]:
    """
    指定パスが属するドライブの `<Drive>:\\Loome` の所有権を検査する。
    戻り値: (status, info_dict)
      - status == "none"    : そのドライブに Loome フォルダは存在しない（制限なし）
      - status == "own"     : 自分の Loome（アクセス・管理許可）
      - status == "foreign" : 他人の Loome（エシカル保護により閲覧・ドライブ管理登録・Loome作成を完全拒否）
    """
    from .volume_info import get_volume_info

    path_str = str(drive_or_path or "").strip()
    if not path_str:
        return "none", {}

    try:
        abs_p = Path(os.path.abspath(path_str))
        # プロジェクトルート配下（本体 Loome/ や storage/）は常に own
        try:
            abs_p.resolve().relative_to(PROJECT_ROOT.resolve())
            return "own", {"is_internal": True}
        except ValueError:
            pass

        drive_anchor = abs_p.anchor
        if not drive_anchor:
            return "none", {}
        if abs_p.name.lower() == "loome" and abs_p.is_dir():
            drive_root = abs_p.parent
        elif (abs_p / "Loome").is_dir():
            drive_root = abs_p
        else:
            drive_root = Path(drive_anchor)
    except Exception:
        return "none", {}

    vsn = (volume_serial or "").strip().upper()
    if not vsn:
        vinfo = get_volume_info(str(drive_root))
        vsn = (vinfo.get("serial") or "").strip().upper() if vinfo else ""

    with _sec_lock:
        if not _runtime_state["initialized"]:
            initialize_security_state()
        owner_id = str(_runtime_state.get("owner_id") or "")
        owner_secret = _runtime_state.get("owner_secret") or b""
        approved_vsns = set(_runtime_state.get("approved_foreign_vsns") or set())

    if vsn and vsn in approved_vsns:
        return "own", {"vsn": vsn, "approved_in_session": True}

    cache_key = (str(drive_root).upper(), vsn, owner_id)
    now_ts = time.monotonic()
    with _sec_lock:
        cached = _drive_loome_cache.get(cache_key)
        if cached and (now_ts - cached[0]) <= _DRIVE_LOOME_CACHE_TTL:
            return cached[1], cached[2]

    loome_dir = drive_root / "Loome"
    try:
        if not loome_dir.exists() or not loome_dir.is_dir():
            res = ("none", {"drive": str(drive_root), "vsn": vsn})
            with _sec_lock:
                _drive_loome_cache[cache_key] = (now_ts, res[0], res[1])
            return res
    except Exception:
        return "none", {}

    seal_path = loome_dir / LOOME_SEAL_FILENAME
    if seal_path.exists():
        try:
            with open(seal_path, "r", encoding="utf-8") as f:
                seal = json.load(f)
            seal_owner = str(seal.get("owner_id") or "")
            seal_vsn = str(seal.get("vsn") or vsn).strip().upper()
            seal_mac = str(seal.get("seal_mac") or "")

            # 1. 自DBの owner_id & HMAC 署名と一致するか
            if owner_id and owner_secret and seal_owner == owner_id:
                expected_mac = _compute_loome_seal_mac(owner_secret, owner_id, seal_vsn)
                if hmac.compare_digest(seal_mac, expected_mac):
                    res = ("own", {"drive": str(drive_root), "vsn": vsn, "loome_path": str(loome_dir)})
                    with _sec_lock:
                        _drive_loome_cache[cache_key] = (now_ts, res[0], res[1])
                    return res

            # 2. 他の owner_id だが、パスワードまたはリカバリーコードで保護された自分の別PCの Loome かどうか
            pw_protected = bool(
                (seal.get("pw_protected") and seal.get("pw_salt") and seal.get("wrapped_owner_bundle"))
                or (seal.get("recovery_salt") and seal.get("dek_wrapped_recovery"))
            )
            res = (
                "foreign",
                {
                    "drive": str(drive_root),
                    "vsn": vsn,
                    "loome_path": str(loome_dir),
                    "foreign_owner_id": seal_owner[:8] + "..." if seal_owner else "不明",
                    "pw_protected": pw_protected,
                    "reason": "sealed_by_other_owner",
                },
            )
            with _sec_lock:
                _drive_loome_cache[cache_key] = (now_ts, res[0], res[1])
            return res
        except Exception as e:
            logger.warning(f".loome_seal 解析失敗 ({seal_path}): {e}")

    # .loome_seal が存在しない場合：
    # 自DBに既に登録済み（アップデート前の自分の既存Loome）または空フォルダなら自分のLoomeとして刻印を自動付与
    if _is_loome_registered_in_own_db(vsn, loome_dir) or not _has_user_files_in_loome(loome_dir):
        if owner_id and owner_secret:
            write_loome_seal(loome_dir, volume_serial=vsn)
        res = ("own", {"drive": str(drive_root), "vsn": vsn, "loome_path": str(loome_dir), "auto_sealed": True})
        with _sec_lock:
            _drive_loome_cache[cache_key] = (now_ts, res[0], res[1])
        return res

    # .loome_seal が無く、自DBに登録履歴もないのに Loome 内にファイルが存在する -> 他人の Loome として保護ロック！
    res = (
        "foreign",
        {
            "drive": str(drive_root),
            "vsn": vsn,
            "loome_path": str(loome_dir),
            "foreign_owner_id": "未刻印（他環境で作成）",
            "pw_protected": False,
            "reason": "unsealed_non_empty_foreign_loome",
        },
    )
    with _sec_lock:
        _drive_loome_cache[cache_key] = (now_ts, res[0], res[1])
    return res


def is_drive_blocked_by_foreign_loome(
    path_or_drive: Union[str, Path],
    volume_serial: Optional[str] = None,
) -> Tuple[bool, Dict[str, Any]]:
    """指定パスまたはドライブが「他人の Loome を含むドライブ」としてブロック対象かを返す"""
    status, info = inspect_drive_loome_ownership(path_or_drive, volume_serial=volume_serial)
    return (status == "foreign"), info


def assert_drive_not_blocked_by_foreign_loome(
    path_or_drive: Union[str, Path],
    volume_serial: Optional[str] = None,
) -> None:
    """他人の Loome が存在するドライブへの操作であれば PermissionError を送出する"""
    blocked, info = is_drive_blocked_by_foreign_loome(path_or_drive, volume_serial=volume_serial)
    if blocked:
        drive_label = info.get("drive") or str(path_or_drive)
        raise PermissionError(
            f"ドライブ ({drive_label}) には他の環境の Loome が存在するため、エシカル保護により閲覧・管理登録・Loome作成はできません。"
        )


def _extract_deks_from_seal_dict(seal_obj: Dict[str, Any], secret_input: str) -> List[bytes]:
    """
    .loome_seal（および previous_seals 履歴）から、パスワードまたはリカバリーコードで復号可能なすべての DEK を抽出する。
    """
    candidate = (secret_input or "").strip()
    if not candidate or not isinstance(seal_obj, dict):
        return []

    found_deks: List[bytes] = []
    seal_entries: List[Dict[str, Any]] = [seal_obj]
    prev_list = seal_obj.get("previous_seals")
    if isinstance(prev_list, list):
        seal_entries.extend(p for p in prev_list if isinstance(p, dict))

    rec_norm = normalize_recovery_code(candidate)

    for entry in seal_entries:
        entry_owner = str(entry.get("owner_id") or "")
        # 1. パスワードラップの試行
        pw_salt_hex = str(entry.get("pw_salt") or "")
        pw_wrap_hex = str(entry.get("wrapped_owner_bundle") or "")
        if pw_salt_hex and pw_wrap_hex:
            try:
                pw_kek = derive_kek(candidate, bytes.fromhex(pw_salt_hex))
                b_bytes = aead_decrypt(pw_kek, bytes.fromhex(pw_wrap_hex), aad=entry_owner.encode("utf-8"))
                b_json = json.loads(b_bytes.decode("utf-8"))
                dek_candidate = bytes.fromhex(b_json["dek"])
                if len(dek_candidate) == 32 and dek_candidate not in found_deks:
                    found_deks.append(dek_candidate)
            except Exception:
                pass

        # 2. リカバリーコードラップの試行
        rec_salt_hex = str(entry.get("recovery_salt") or "")
        rec_wrap_hex = str(entry.get("dek_wrapped_recovery") or "")
        if rec_salt_hex and rec_wrap_hex and rec_norm:
            try:
                rec_kek = derive_kek(rec_norm, bytes.fromhex(rec_salt_hex))
                b_bytes = aead_decrypt(rec_kek, bytes.fromhex(rec_wrap_hex), aad=entry_owner.encode("utf-8"))
                b_json = json.loads(b_bytes.decode("utf-8"))
                dek_candidate = bytes.fromhex(b_json["dek"])
                if len(dek_candidate) == 32 and dek_candidate not in found_deks:
                    found_deks.append(dek_candidate)
            except Exception:
                pass

    return found_deks


def unlock_foreign_loome_with_password(volume_serial: str, password: str) -> Dict[str, Any]:
    """
    自分の別PCで作成した外付け Loome に対して、同じパスワード（またはリカバリーコード）を入力することで
    正当なオーナーであることを証明し、現在の Tetheract 環境でも自分の Loome として承認・復号する。
    """
    from .volume_info import find_online_drive_for_serial

    clean_vsn = (volume_serial or "").strip().upper()
    if not clean_vsn:
        raise ValueError("ボリュームシリアル番号が指定されていません。")
    if not password or not password.strip():
        raise ValueError("パスワードまたはリカバリーコードを入力してください。")

    online_info = find_online_drive_for_serial(clean_vsn)
    if not online_info or not online_info.get("drive"):
        raise ValueError("対象のドライブが現在接続されていません。")

    raw_drive = str(online_info["drive"])
    if Path(raw_drive).is_dir() and (Path(raw_drive) / "Loome").is_dir():
        loome_dir = Path(raw_drive) / "Loome"
        drive_letter = raw_drive[:1].upper() if (len(raw_drive) >= 2 and raw_drive[1] == ":") else "Z"
    else:
        drive_letter = raw_drive.rstrip(":\\/")
        loome_dir = Path(f"{drive_letter}:\\Loome")
    seal_path = loome_dir / LOOME_SEAL_FILENAME
    if not seal_path.exists():
        raise ValueError("この Loome には認証情報（.loome_seal）が記録されていないため、承認できません。")

    with open(seal_path, "r", encoding="utf-8") as f:
        seal = json.load(f)

    has_any_wrap = bool(
        (seal.get("pw_protected") and seal.get("pw_salt") and seal.get("wrapped_owner_bundle"))
        or (seal.get("recovery_salt") and seal.get("dek_wrapped_recovery"))
        or seal.get("previous_seals")
    )
    if not has_any_wrap:
        raise ValueError("この Loome にはパスワードまたはリカバリーコードの認証情報が記録されていません。")

    extracted_deks = _extract_deks_from_seal_dict(seal, password)
    if not extracted_deks:
        raise ValueError("パスワードまたはリカバリーコードが一致しないため、この Loome を承認できませんでした。")

    # もし外付け Loome 内のファイルが旧環境の foreign_dek で Lv.2 カプセル化されていた場合、
    # 現在の環境の DEK へ再カプセル化（または Lv.0/1 なら復号復元）して完全統合する
    with _sec_lock:
        if not _runtime_state["initialized"]:
            initialize_security_state()
        current_dek = _runtime_state.get("dek")
        current_level = int(_runtime_state.get("security_level", 0))
        _runtime_state["approved_foreign_vsns"].add(clean_vsn)
        fb_list: List[bytes] = list(_runtime_state.get("fallback_deks") or [])
        for f_dek in extracted_deks:
            if f_dek not in fb_list:
                fb_list.append(f_dek)
        _runtime_state["fallback_deks"] = fb_list

    for f_dek in extracted_deks:
        unseal_all_files_in_directory(loome_dir, f_dek)
    if current_level == 2 and current_dek and len(current_dek) == 32:
        seal_all_files_in_directory(loome_dir, current_dek)

    # 現環境の刻印に更新（旧シールは write_loome_seal 内で previous_seals に自動保存される）
    write_loome_seal(loome_dir, volume_serial=clean_vsn, password=password)
    clear_drive_loome_cache()

    from .database.folders import add_scan_root, set_volume_loome_enabled
    set_volume_loome_enabled(
        volume_serial=clean_vsn,
        enabled=True,
        volume_label=online_info.get("label") or "",
        drive_letter=f"{drive_letter}:",
    )
    add_scan_root(str(loome_dir))

    return {
        "status": "ok",
        "volume_serial": clean_vsn,
        "loome_path": str(loome_dir),
        "message": "認証に成功し、自分の Loome として承認されました。",
    }


# ==============================================================================
# 5. Lv.2 Loome ファイルカプセル化（先頭64KB暗号化 ＋ 72Bフッター）
# ==============================================================================

def _get_candidate_vault_deks(primary_dek: Optional[bytes] = None) -> List[bytes]:
    """Lv.2 ファイル復号用の候補DEKリスト（指定DEK -> 現在のDEK -> fallback_deks）を返す"""
    candidates: List[bytes] = []
    if primary_dek and len(primary_dek) == 32:
        candidates.append(primary_dek)
    active = get_active_dek()
    if active and len(active) == 32 and active not in candidates:
        candidates.append(active)
    with _sec_lock:
        for fb in (_runtime_state.get("fallback_deks") or []):
            if isinstance(fb, bytes) and len(fb) == 32 and fb not in candidates:
                candidates.append(fb)
    return candidates


def is_vault_encrypted_file(file_path: Union[str, Path]) -> bool:
    """指定ファイルが Lv.2 Loome カプセル化済み（先頭8バイトが TETHVLT1）かどうかを高速判定する"""
    try:
        p = Path(file_path)
        if not p.is_file():
            return False
        with open(p, "rb") as f:
            head8 = f.read(8)
        return head8 == VAULT_MAGIC
    except Exception:
        return False


def get_logical_file_size(file_path: Union[str, Path]) -> int:
    """
    ファイルの論理サイズ（元の未暗号化サイズ）を返す。
    Lv.2 カプセル化済みファイルの場合は末尾の 72B フッターを除いた元のファイルサイズを返す。
    """
    p = Path(file_path)
    st_size = p.stat().st_size
    if st_size > VAULT_FOOTER_SIZE and is_vault_encrypted_file(p):
        return st_size - VAULT_FOOTER_SIZE
    return st_size


def seal_loome_file(file_path: Union[str, Path], dek: Optional[bytes] = None) -> bool:
    """
    単一の画像/RAWファイルを Lv.2 カプセル化（先頭最大64KBをインプレースXOR暗号化＋末尾72Bフッター付与）する。
    既にカプセル化済みの場合は何もしない。ファイルの更新日時 (mtime) は元のまま維持する。
    クラッシュ耐性のため、先に末尾72Bフッターをフラッシュしてから先頭64KBを上書きする。
    """
    key = dek if (dek and len(dek) == 32) else get_active_dek()
    if not key:
        return False

    p = Path(file_path)
    if not p.is_file():
        return False
    if p.name.startswith(".") or p.suffix.lower() in (".xmp", ".pp3", ".dop", ".acr", ".on1", ".cos", ".db", ".json"):
        return False

    try:
        st = p.stat()
        orig_size = st.st_size
        if orig_size < 16:
            return False
        orig_atime_ns = st.st_atime_ns
        orig_mtime_ns = st.st_mtime_ns

        with open(p, "r+b") as f:
            head8 = f.read(8)
            if head8 == VAULT_MAGIC:
                return False  # 既にカプセル化済み

            # 万一、前回のカプセル化または解除の途中で電源断が発生し末尾に未コミットの72Bフッターだけが残っている場合は検証の上で除去
            if orig_size > VAULT_FOOTER_SIZE + 16:
                f.seek(orig_size - VAULT_FOOTER_SIZE)
                tail_footer = f.read(VAULT_FOOTER_SIZE)
                if len(tail_footer) == VAULT_FOOTER_SIZE and tail_footer[64:72] == VAULT_MAGIC:
                    t_nonce = tail_footer[8:24]
                    t_mac = tail_footer[24:56]
                    t_mtime_bytes = tail_footer[56:64]
                    cand_orig_size = orig_size - VAULT_FOOTER_SIZE
                    cand_chunk_len = min(cand_orig_size, VAULT_CHUNK_SIZE)
                    f.seek(0)
                    cand_plain = f.read(cand_chunk_len)
                    for cand_key in _get_candidate_vault_deks(key):
                        t_ks = hashlib.shake_256(cand_key + t_nonce + b"VAULT_ENC_V1").digest(cand_chunk_len)
                        t_cipher = _xor_bytes(cand_plain, t_ks)
                        t_mac_key = hashlib.shake_256(cand_key + t_nonce + b"VAULT_MAC_V1").digest(32)
                        t_exp_mac = hmac.digest(t_mac_key, VAULT_MAGIC + t_nonce + t_mtime_bytes + t_cipher, "sha256")
                        if hmac.compare_digest(t_mac, t_exp_mac):
                            orig_size = cand_orig_size
                            f.truncate(orig_size)
                            f.flush()
                            break

            f.seek(0)
            chunk_len = min(orig_size, VAULT_CHUNK_SIZE)
            plain_chunk = f.read(chunk_len)

            nonce = secrets.token_bytes(16)
            ks = hashlib.shake_256(key + nonce + b"VAULT_ENC_V1").digest(chunk_len)
            cipher_chunk = _xor_bytes(plain_chunk, ks)
            cipher_head8 = cipher_chunk[:8]

            orig_mtime_bytes = struct.pack("<Q", orig_mtime_ns)
            mac_key = hashlib.shake_256(key + nonce + b"VAULT_MAC_V1").digest(32)
            mac = hmac.digest(mac_key, VAULT_MAGIC + nonce + orig_mtime_bytes + cipher_chunk, "sha256")
            footer = cipher_head8 + nonce + mac + orig_mtime_bytes + VAULT_MAGIC

            # 1. 先に末尾へ 72B フッターを書き込んでフラッシュ（先行フッターコミット）
            f.seek(orig_size)
            f.write(footer)
            f.truncate(orig_size + VAULT_FOOTER_SIZE)
            f.flush()

            # 2. 先頭8バイトを VAULT_MAGIC にし、9バイト目〜chunk_len を暗号文で上書き
            f.seek(0)
            f.write(VAULT_MAGIC + cipher_chunk[8:])
            f.flush()

        try:
            os.utime(p, ns=(orig_atime_ns, orig_mtime_ns))
        except Exception as ut_err:
            logger.debug(f"カプセル化後のutime復元スキップ ({p}): {ut_err}")
        return True
    except Exception as e:
        logger.error(f"Loomeファイルのカプセル化失敗 ({p}): {e}")
        return False


def unseal_loome_file(file_path: Union[str, Path], dek: Optional[bytes] = None) -> bool:
    """
    Lv.2 カプセル化済みのファイルをインプレースで元の無加工ファイルへ完全復元する。
    現在のDEKだけでなく fallback_deks（過去シールからサルベージされたDEK）でも復号を試行する。
    """
    candidate_keys = _get_candidate_vault_deks(dek)
    if not candidate_keys:
        return False

    p = Path(file_path)
    if not p.is_file():
        return False

    try:
        st = p.stat()
        total_size = st.st_size
        if total_size <= VAULT_FOOTER_SIZE:
            return False
        orig_atime_ns = st.st_atime_ns

        with open(p, "r+b") as f:
            head8 = f.read(8)
            if head8 != VAULT_MAGIC:
                return False

            orig_size = total_size - VAULT_FOOTER_SIZE
            chunk_len = min(orig_size, VAULT_CHUNK_SIZE)

            f.seek(0)
            disk_chunk = f.read(chunk_len)
            f.seek(orig_size)
            footer = f.read(VAULT_FOOTER_SIZE)
            if len(footer) != VAULT_FOOTER_SIZE or footer[64:72] != VAULT_MAGIC:
                raise ValueError("カプセル化フッターが破損しています")

            cipher_head8 = footer[0:8]
            nonce = footer[8:24]
            mac = footer[24:56]
            orig_mtime_bytes = footer[56:64]
            orig_mtime_ns = struct.unpack("<Q", orig_mtime_bytes)[0]

            cipher_chunk = cipher_head8 + disk_chunk[8:]
            matched_key: Optional[bytes] = None
            for cand_key in candidate_keys:
                mac_key = hashlib.shake_256(cand_key + nonce + b"VAULT_MAC_V1").digest(32)
                expected_mac = hmac.digest(mac_key, VAULT_MAGIC + nonce + orig_mtime_bytes + cipher_chunk, "sha256")
                if hmac.compare_digest(mac, expected_mac):
                    matched_key = cand_key
                    break

            if matched_key is None:
                raise ValueError("カプセル化ファイルの認証MACが一致しません")

            ks = hashlib.shake_256(matched_key + nonce + b"VAULT_ENC_V1").digest(chunk_len)
            plain_chunk = _xor_bytes(cipher_chunk, ks)

            # 1. 先に先頭チャンクを平文へ戻してフラッシュ
            f.seek(0)
            f.write(plain_chunk)
            f.flush()
            # 2. フッターを切り詰める
            f.truncate(orig_size)
            f.flush()

        try:
            os.utime(p, ns=(orig_atime_ns, orig_mtime_ns))
        except Exception as ut_err:
            logger.debug(f"カプセル解除後のutime復元スキップ ({p}): {ut_err}")
        return True
    except Exception as e:
        logger.error(f"Loomeファイルのカプセル化解除失敗 ({p}): {e}")
        return False


def read_loome_file_decrypted_bytes(file_path: Union[str, Path], max_bytes: Optional[int] = None) -> bytes:
    """
    ファイルを読み込み、Lv.2 カプセル化されている場合はメモリ上で透過的に復号したバイト列を返す。
    max_bytes が指定されている場合は先頭から最大 max_bytes 分のみを返す（Exif/レンズ解析等の高速化用）。
    """
    p = Path(file_path)
    st_size = p.stat().st_size
    with open(p, "rb") as f:
        head8 = f.read(8)
        if head8 != VAULT_MAGIC or st_size <= VAULT_FOOTER_SIZE:
            f.seek(0)
            return f.read(max_bytes) if max_bytes is not None else f.read()

        candidate_keys = _get_candidate_vault_deks()
        if not candidate_keys:
            raise PermissionError("ロック中または復号キーが未ロードのため、保護された Loome ファイルを読み込めません。")

        orig_size = st_size - VAULT_FOOTER_SIZE
        chunk_len = min(orig_size, VAULT_CHUNK_SIZE)

        f.seek(0)
        disk_chunk = f.read(chunk_len)
        f.seek(orig_size)
        footer = f.read(VAULT_FOOTER_SIZE)
        if len(footer) != VAULT_FOOTER_SIZE or footer[64:72] != VAULT_MAGIC:
            raise ValueError("カプセル化フッターが破損しています")

        cipher_head8 = footer[0:8]
        nonce = footer[8:24]
        mac = footer[24:56]
        orig_mtime_bytes = footer[56:64]

        cipher_chunk = cipher_head8 + disk_chunk[8:]
        matched_key: Optional[bytes] = None
        for cand_key in candidate_keys:
            mac_key = hashlib.shake_256(cand_key + nonce + b"VAULT_MAC_V1").digest(32)
            expected_mac = hmac.digest(mac_key, VAULT_MAGIC + nonce + orig_mtime_bytes + cipher_chunk, "sha256")
            if hmac.compare_digest(mac, expected_mac):
                matched_key = cand_key
                break

        if matched_key is None:
            raise ValueError("カプセル化ファイルの認証MACが一致しません")

        ks = hashlib.shake_256(matched_key + nonce + b"VAULT_ENC_V1").digest(chunk_len)
        plain_chunk = _xor_bytes(cipher_chunk, ks)

        if max_bytes is not None and max_bytes <= chunk_len:
            return plain_chunk[:max_bytes]

        f.seek(chunk_len)
        rest_to_read = (orig_size - chunk_len) if max_bytes is None else min(orig_size - chunk_len, max_bytes - chunk_len)
        rest_bytes = f.read(max(0, rest_to_read))
        return plain_chunk + rest_bytes


def copy_file_unsealed(src_path: Union[str, Path], dst_path: Union[str, Path]) -> None:
    """
    ファイルをコピーする際、コピー元が Lv.2 カプセル化されている場合は復号して元の無加工ファイルとして dst_path に書き出す。
    通常ファイルの場合は shutil.copy2 でそのまま高速コピーする。
    """
    src = Path(src_path)
    dst = Path(dst_path)
    if not is_vault_encrypted_file(src):
        shutil.copy2(src, dst)
        return

    plain_bytes = read_loome_file_decrypted_bytes(src)
    st = src.stat()
    with open(dst, "wb") as f:
        f.write(plain_bytes)
    try:
        os.utime(dst, ns=(st.st_atime_ns, st.st_mtime_ns))
    except Exception:
        pass


@contextlib.contextmanager
def decrypted_file_path_context(file_path: Union[str, Path]) -> Iterator[Path]:
    """
    rawpy 等のファイルパスを要求するC拡張ライブラリ向けに、
    通常ファイルならそのままの Path を返し、Lv.2 カプセル化ファイルなら一時復号ファイルの Path を返して終了時に確実削除する。
    """
    p = Path(file_path)
    if not is_vault_encrypted_file(p):
        yield p
        return

    tmp_fd, tmp_name = tempfile.mkstemp(suffix=p.suffix, prefix="teth_vlt_")
    os.close(tmp_fd)
    tmp_path = Path(tmp_name)
    try:
        copy_file_unsealed(p, tmp_path)
        yield tmp_path
    finally:
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except Exception:
            pass


def seal_all_files_in_directory(root_dir: Path, dek: Optional[bytes] = None) -> int:
    """指定 Loome ディレクトリ配下の全対象画像・RAWファイルを再帰的にカプセル化する"""
    from .scanner import SUPPORTED_EXTENSIONS
    if not root_dir or not root_dir.exists() or not root_dir.is_dir():
        return 0
    count = 0
    for dirpath, dirnames, filenames in os.walk(str(root_dir)):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for fname in filenames:
            if fname.startswith("."):
                continue
            ext = os.path.splitext(fname)[1].lower()
            if ext in SUPPORTED_EXTENSIONS:
                full_p = Path(dirpath) / fname
                if seal_loome_file(full_p, dek=dek):
                    count += 1
    return count


def unseal_all_files_in_directory(root_dir: Path, dek: Optional[bytes] = None) -> int:
    """指定 Loome ディレクトリ配下の全カプセル化ファイルを再帰的に元の無加工ファイルへ復元する"""
    if not root_dir or not root_dir.exists() or not root_dir.is_dir():
        return 0
    count = 0
    for dirpath, dirnames, filenames in os.walk(str(root_dir)):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for fname in filenames:
            if fname.startswith("."):
                continue
            full_p = Path(dirpath) / fname
            if is_vault_encrypted_file(full_p):
                if unseal_loome_file(full_p, dek=dek):
                    count += 1
    return count


def _get_all_own_online_loome_dirs() -> List[Tuple[Path, str]]:
    """現在接続されている「自分の Loome」ディレクトリ一覧 (Path, vsn) を返す"""
    from .database.folders import get_all_volumes
    from .volume_info import find_online_drive_for_serial, get_volume_info

    result: List[Tuple[Path, str]] = []
    seen_paths = set()
    for internal_dir in _get_internal_loome_dirs():
        norm_p = str(internal_dir.resolve()).lower()
        if norm_p not in seen_paths:
            seen_paths.add(norm_p)
            vinfo = get_volume_info(str(internal_dir))
            vsn = (vinfo.get("serial") or "").strip().upper() if vinfo else ""
            result.append((internal_dir, vsn))

    try:
        for vol in get_all_volumes():
            if not vol.get("loome_enabled"):
                continue
            vsn = str(vol.get("volume_serial") or "").strip().upper()
            if not vsn:
                continue
            online = find_online_drive_for_serial(vsn)
            if online and online.get("drive"):
                raw_drv = str(online["drive"])
                if Path(raw_drv).is_dir() and (Path(raw_drv) / "Loome").is_dir():
                    ext_loome = Path(raw_drv) / "Loome"
                else:
                    drv = raw_drv.rstrip(":\\/")
                    ext_loome = Path(f"{drv}:\\Loome")
                if ext_loome.exists() and ext_loome.is_dir():
                    norm_p = str(ext_loome.resolve()).lower()
                    if norm_p not in seen_paths:
                        status, _ = inspect_drive_loome_ownership(ext_loome, volume_serial=vsn)
                        if status == "own":
                            seen_paths.add(norm_p)
                            result.append((ext_loome, vsn))
    except Exception as e:
        logger.debug(f"有効化済み外付けLoome列挙スキップ: {e}")

    return result


# ==============================================================================
# 6. セキュリティレベル変更 ＆ DBサムネイル・Loome 一括マイグレーション
# ==============================================================================

def _migrate_thumbnails_encryption(encrypt: bool, dek: bytes) -> Dict[str, int]:
    """
    thumbnails テーブルの全 BLOB に対して一括で暗号化 (encrypt=True) または復号 (encrypt=False) を行う。
    - 重複写真統合等で photo_id が変化したサムネイルにも対応するため encrypt_thumbnail_blob / decrypt_thumbnail_blob を使用する。
    - 万一復号不能な破損サムネイル行が存在した場合はマイグレーションを止めず該当行のみ削除（次回表示時に自動再生成）する。
    - 暗号化完了時は VACUUM を実行して SQLite 空きページの平文痕跡も完全消去する。
    """
    from .database.connection import get_connection
    from .database.stats import vacuum_database

    processed = 0
    skipped = 0
    corrupted_ids: List[int] = []

    with get_connection() as conn:
        cur = conn.cursor()
        cur.execute("SELECT photo_id, data FROM thumbnails")
        rows = cur.fetchall()

        updates: List[Tuple[bytes, int]] = []
        for r in rows:
            pid = int(r["photo_id"])
            blob = bytes(r["data"]) if r["data"] else b""
            if not blob:
                skipped += 1
                continue
            already_enc = is_encrypted_blob(blob)
            if encrypt and not already_enc:
                enc_blob = encrypt_thumbnail_blob(dek, blob, photo_id=pid)
                updates.append((enc_blob, pid))
                processed += 1
            elif not encrypt and already_enc:
                try:
                    dec_blob = decrypt_thumbnail_blob(dek, blob, photo_id=pid)
                    updates.append((dec_blob, pid))
                    processed += 1
                except Exception as dec_err:
                    logger.warning(f"サムネイル復号スキップ（破損キャッシュ行を削除して再生成対象にします: photo_id={pid}）: {dec_err}")
                    corrupted_ids.append(pid)
            else:
                skipped += 1

        if updates:
            cur.executemany("UPDATE thumbnails SET data = ? WHERE photo_id = ?", updates)
        if corrupted_ids:
            cur.executemany("DELETE FROM thumbnails WHERE photo_id = ?", [(pid,) for pid in corrupted_ids])
        if updates or corrupted_ids:
            conn.commit()

    if encrypt and processed > 0:
        try:
            vacuum_database()
        except Exception as e:
            logger.warning(f"サムネイル暗号化後のVACUUMで警告: {e}")

    return {"processed": processed, "skipped": skipped, "deleted_corrupted": len(corrupted_ids)}


def configure_security_level(
    target_level: int,
    current_password: Optional[str] = None,
    new_password: Optional[str] = None,
) -> Dict[str, Any]:
    """
    セキュリティレベル（0: エシカル, 1: 起動＆DBロック, 2: フルロック）の設定・変更、
    およびパスワードの設定・変更を行い、必要なDBサムネイル＆Loomeファイルの暗号化/復号マイグレーションを実行する。
    マイグレーション途中の電源断でも鍵を見失わないよう、Step 0 で先行して鍵ラップを DB と .loome_seal にコミットする。
    """
    from .database.connection import get_connection

    if target_level not in (0, 1, 2):
        raise ValueError("セキュリティレベルは 0, 1, 2 のいずれかを指定してください。")

    with _sec_lock:
        if not _runtime_state["initialized"]:
            initialize_security_state()
        if is_app_locked():
            raise PermissionError("ロック中はセキュリティ設定を変更できません。先にロックを解除してください。")

        old_level = int(_runtime_state["security_level"])
        owner_id = str(_runtime_state["owner_id"])
        owner_secret = bytes(_runtime_state["owner_secret"])
        dek = bytes(_runtime_state["dek"])
        recovery_code = str(_runtime_state["recovery_code"])

        with get_connection() as conn:
            meta = _get_meta_map(conn)

        existing_pw_salt_hex = meta.get("pw_salt", "")
        existing_wrapped_pw_hex = meta.get("dek_wrapped_pw", "")

        # 既に Lv.1 / Lv.2（またはパスワード設定済み）の場合、現在のパスワード（またはリカバリーコード）の検証を必須とする
        if old_level >= 1 or existing_wrapped_pw_hex:
            if not current_password:
                raise ValueError("設定を変更するには現在のパスワードを入力してください。")
            verified = False
            if existing_pw_salt_hex and existing_wrapped_pw_hex:
                try:
                    chk_kek = derive_kek(current_password, bytes.fromhex(existing_pw_salt_hex))
                    aead_decrypt(chk_kek, bytes.fromhex(existing_wrapped_pw_hex), aad=owner_id.encode("utf-8"))
                    verified = True
                except Exception:
                    verified = False
            if not verified:
                # リカバリーコードでも許可
                rec_salt_hex = meta.get("recovery_salt", "")
                wrapped_rec_hex = meta.get("dek_wrapped_recovery", "")
                if rec_salt_hex and wrapped_rec_hex:
                    try:
                        rec_kek = derive_kek(normalize_recovery_code(current_password), bytes.fromhex(rec_salt_hex))
                        aead_decrypt(rec_kek, bytes.fromhex(wrapped_rec_hex), aad=owner_id.encode("utf-8"))
                        verified = True
                    except Exception:
                        verified = False
            if not verified:
                raise ValueError("現在のパスワードが正しくありません。")

        effective_password = (new_password or "").strip() or (current_password or "").strip()
        if target_level >= 1 and len(effective_password) < 4:
            raise ValueError("Lv.1 / Lv.2 を有効にするには4文字以上のパスワードを設定してください。")

        bundle_plain = json.dumps({
            "dek": dek.hex(),
            "owner_secret": owner_secret.hex(),
            "recovery_code": recovery_code,
        }).encode("utf-8")

        # 本体フォルダに Loome ディレクトリが未作成でも、Lv.1/Lv.2 設定時は鍵サルベージ用カプセル (.loome_seal) のため確実に用意する
        if target_level >= 1 and not _get_internal_loome_dirs():
            try:
                default_internal_loome = _get_active_project_root() / "Loome"
                default_internal_loome.mkdir(parents=True, exist_ok=True)
            except Exception:
                pass

        loome_dirs = _get_all_own_online_loome_dirs()

        # 0. 【Write-Ahead Key Commit】マイグレーション中のクラッシュや強制終了でもパスワードラップを失わないよう先行コミット
        pw_salt_hex_new = ""
        wrapped_pw_new = ""
        if target_level >= 1:
            pw_salt = secrets.token_bytes(16)
            pw_kek = derive_kek(effective_password, pw_salt)
            pw_salt_hex_new = pw_salt.hex()
            wrapped_pw_new = aead_encrypt(pw_kek, bundle_plain, aad=owner_id.encode("utf-8")).hex()
            with get_connection() as conn:
                _set_meta_values(conn, {
                    "pw_salt": pw_salt_hex_new,
                    "dek_wrapped_pw": wrapped_pw_new,
                    "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                })
                conn.commit()
            for l_dir, l_vsn in loome_dirs:
                write_loome_seal(l_dir, volume_serial=l_vsn, password=effective_password)

        # 1. サムネイルBLOBの暗号化 / 復号マイグレーション（内部で vacuum_database() が接続を閉じて再構築する）
        thumb_mig = _migrate_thumbnails_encryption(encrypt=(target_level >= 1), dek=dek)

        # 2. Loome ファイルのカプセル化 / 復元マイグレーション
        loome_sealed_count = 0
        loome_unsealed_count = 0
        for l_dir, l_vsn in loome_dirs:
            if target_level == 2:
                loome_sealed_count += seal_all_files_in_directory(l_dir, dek=dek)
            else:
                loome_unsealed_count += unseal_all_files_in_directory(l_dir, dek=dek)

        # 3. メタデータの最終確定（VACUUM 後に新しい接続を取得して書き込む）
        updates: Dict[str, str] = {
            "security_level": str(target_level),
            "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }

        with get_connection() as conn:
            if target_level >= 1:
                updates["pw_salt"] = pw_salt_hex_new
                updates["dek_wrapped_pw"] = wrapped_pw_new
                updates["vsn_rescue_bundles"] = "{}"  # Lv.1/2 ではパスワードなしでのVSN自動復元を無効化
                _set_meta_values(conn, updates)
                _bind_current_instance_in_db(conn, owner_id, bundle_plain, target_level)
            else:
                updates["pw_salt"] = ""
                updates["dek_wrapped_pw"] = ""
                updates["vsn_rescue_bundles"] = _build_vsn_rescue_bundles(conn, owner_id, bundle_plain)
                _set_meta_values(conn, updates)
                _bind_current_instance_in_db(conn, owner_id, bundle_plain, 0)

            conn.commit()

        _runtime_state["security_level"] = target_level
        _runtime_state["is_locked"] = False
        _runtime_state["db_foreign_locked"] = False
        _runtime_state["has_password"] = bool(target_level >= 1)

        # 4. 接続中の自分の全 Loome の .loome_seal を最終状態に更新
        for l_dir, l_vsn in loome_dirs:
            write_loome_seal(
                l_dir,
                volume_serial=l_vsn,
                password=effective_password if target_level >= 1 else None,
            )

        clear_drive_loome_cache()
        res = get_security_status()
        res["migration"] = {
            "thumbnails_processed": thumb_mig["processed"],
            "loome_files_sealed": loome_sealed_count,
            "loome_files_unsealed": loome_unsealed_count,
        }
        return res


def lock_session_now() -> Dict[str, Any]:
    """Lv.1 / Lv.2 設定中にユーザーが手動で「今すぐロック」を実行した際にメモリ上の鍵を破棄してロック状態にする"""
    with _sec_lock:
        if not _runtime_state["initialized"]:
            initialize_security_state()
        if int(_runtime_state["security_level"]) < 1:
            raise ValueError("即時ロックは Lv.1 または Lv.2 が有効な場合のみ使用できます。")
        _runtime_state["is_locked"] = True
        _runtime_state["dek"] = b""
        _runtime_state["owner_secret"] = b""
        _runtime_state["recovery_code"] = ""
        return get_security_status()
