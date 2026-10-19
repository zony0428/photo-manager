"""
AI自動タグ付け推論モジュール (CLIP INT8 Vision Model + Precomputed Tag Embeddings)
ポータブル動作のため外部GPU不要・CPU推論のみで毎秒30〜50枚の爆速ゼロショットタグ推論を行う。
"""

import io
import json
import logging
import threading
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from PIL import Image

logger = logging.getLogger("photo_manager.ai")

# ルートディレクトリからの相対パス
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
MODEL_DIR = PROJECT_ROOT / "models" / "clip"
VISION_MODEL_PATH = MODEL_DIR / "vision_model_quantized.onnx"
TAG_EMBEDDINGS_PATH = MODEL_DIR / "tags_embeddings.json"
TAG_EMBEDDINGS_FALLBACK_PATH = Path(__file__).resolve().parent / "tags_embeddings.json"

# モデルダウンロードURL（Hugging Face Xenova/clip-vit-base-patch32）
VISION_MODEL_URL = "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model_quantized.onnx"

# CLIP画像前処理用定数 (標準 ImageNet / CLIP)
MEAN = np.array([0.48145466, 0.4578275, 0.40821073], dtype=np.float32).reshape(1, 3, 1, 1)
STD = np.array([0.26862954, 0.26130258, 0.27577711], dtype=np.float32).reshape(1, 3, 1, 1)


class AITagger:
    """CLIPビジョンモデルを用いたゼロショットタグ推論クラス"""

    _instance: Optional["AITagger"] = None
    _lock = threading.Lock()

    def __init__(self):
        self.session = None
        self.tags: List[str] = []
        self.categories: List[str] = []
        self.embeddings: Optional[np.ndarray] = None
        self.color_mask: Optional[np.ndarray] = None
        self.content_mask: Optional[np.ndarray] = None
        self.is_loaded = False
        self._init_lock = threading.Lock()

    @classmethod
    def get_instance(cls) -> "AITagger":
        """シングルトンインスタンスの取得"""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    @staticmethod
    def _resolve_embeddings_path() -> Optional[Path]:
        """タグ埋め込みJSONファイルのパスを解決し、必要に応じてmodels側に復元する"""
        if TAG_EMBEDDINGS_PATH.exists():
            return TAG_EMBEDDINGS_PATH
        if TAG_EMBEDDINGS_FALLBACK_PATH.exists():
            try:
                MODEL_DIR.mkdir(parents=True, exist_ok=True)
                import shutil
                shutil.copyfile(TAG_EMBEDDINGS_FALLBACK_PATH, TAG_EMBEDDINGS_PATH)
                logger.info(f"Restored tags_embeddings.json to {TAG_EMBEDDINGS_PATH}")
                return TAG_EMBEDDINGS_PATH
            except Exception as e:
                logger.warning(f"Could not copy embeddings file to models dir: {e}")
                return TAG_EMBEDDINGS_FALLBACK_PATH
        return None

    def is_available(self) -> bool:
        """モデルファイルおよび埋め込みファイルが存在するか確認"""
        return VISION_MODEL_PATH.exists() and (
            TAG_EMBEDDINGS_PATH.exists() or TAG_EMBEDDINGS_FALLBACK_PATH.exists()
        )

    def ensure_model(self) -> bool:
        """モデルファイルが存在しない場合に自動ダウンロードおよび埋め込みファイルの自己修復を行う"""
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        if not TAG_EMBEDDINGS_PATH.exists():
            self._resolve_embeddings_path()

        if self.is_available():
            return True

        try:
            if not VISION_MODEL_PATH.exists():
                logger.info(f"Downloading vision model to {VISION_MODEL_PATH}...")
                urllib.request.urlretrieve(VISION_MODEL_URL, VISION_MODEL_PATH)
                logger.info("Vision model downloaded successfully.")
            return self.is_available()
        except Exception as e:
            logger.error(f"Failed to download AI vision model: {e}")
            return False

    def load(self) -> bool:
        """モデルおよびタグ埋め込みをメモリにロードする"""
        if self.is_loaded:
            return True

        with self._init_lock:
            if self.is_loaded:
                return True

            if not self.ensure_model():
                logger.warning("AI model files are not available.")
                return False

            try:
                import onnxruntime as ort

                # ONNX セッションの初期化 (CPU 最適化)
                opts = ort.SessionOptions()
                opts.intra_op_num_threads = 2  # 軽量・他処理を圧迫しないよう2スレッド
                opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

                self.session = ort.InferenceSession(str(VISION_MODEL_PATH), sess_options=opts)

                # タグ埋め込みのロード
                embeddings_path = self._resolve_embeddings_path() or TAG_EMBEDDINGS_PATH
                with open(embeddings_path, "r", encoding="utf-8") as f:
                    tag_data = json.load(f)

                self.tags = [item["tag"] for item in tag_data]
                self.categories = [item.get("category", "") for item in tag_data]
                self.embeddings = np.array([item["embedding"] for item in tag_data], dtype=np.float32)
                self.color_mask = np.array([c == "color" for c in self.categories], dtype=bool)
                self.content_mask = ~self.color_mask

                self.is_loaded = True
                logger.info(f"AI Tagger loaded successfully with {len(self.tags)} predefined tags.")
                return True
            except Exception as e:
                logger.error(f"Failed to load AI Tagger: {e}")
                return False

    def _preprocess_image(self, image: Image.Image) -> np.ndarray:
        """PIL画像を中央正方形クロップ ＆ 224x224 にリサイズし、CLIP用テンソルに変換"""
        image = image.convert("RGB")
        w, h = image.size
        short_edge = min(w, h)
        left = (w - short_edge) // 2
        top = (h - short_edge) // 2
        image = image.crop((left, top, left + short_edge, top + short_edge))
        image = image.resize((224, 224), Image.Resampling.BICUBIC)

        arr = np.array(image, dtype=np.float32) / 255.0
        arr = np.transpose(arr, (2, 0, 1))
        arr = np.expand_dims(arr, 0)
        arr = (arr - MEAN) / STD
        return arr

    def predict_from_bytes(
        self,
        image_bytes: bytes,
        top_k: int = 3,
        threshold: float = 0.255,
        color_threshold: float = 0.240,
    ) -> List[Dict[str, Any]]:
        """サムネイル画像バイナリ (WebP/JPEG等) からタグ（被写体＋主要色）を推論する"""
        if not self.is_loaded:
            if not self.load():
                return []

        try:
            image = Image.open(io.BytesIO(image_bytes))
            pixel_values = self._preprocess_image(image)

            outputs = self.session.run(None, {"pixel_values": pixel_values})
            image_embeds = outputs[0][0]  # (512,)

            # L2正規化
            norm = np.linalg.norm(image_embeds)
            if norm > 0:
                image_embeds = image_embeds / norm

            # コサイン類似度
            similarities = np.dot(self.embeddings, image_embeds)  # (N,)

            # 1. 被写体・シーン系タグ (category != 'color')
            valid_content_indices = np.where(self.content_mask & (similarities >= threshold))[0]
            results = []
            if len(valid_content_indices) > 0:
                sorted_order = np.argsort(-similarities[valid_content_indices], kind="stable")
                top_indices = valid_content_indices[sorted_order[:top_k]]
                for idx in top_indices:
                    results.append({
                        "tag": self.tags[idx],
                        "confidence": round(float(similarities[idx]), 3),
                        "category": self.categories[idx],
                    })

            # 2. 主要色合いタグ (category == 'color')
            # 12色の中で最も際立っている色を最大1個付与
            color_indices = np.where(self.color_mask)[0]
            if len(color_indices) > 0:
                sorted_color_order = np.argsort(-similarities[color_indices], kind="stable")
                top_color_idx = color_indices[sorted_color_order[0]]
                top_color_score = float(similarities[top_color_idx])
                second_color_score = (
                    float(similarities[color_indices[sorted_color_order[1]]])
                    if len(sorted_color_order) > 1
                    else 0.0
                )
                # 閾値以上かつ2位とのマージンが一定以上（色が明確）な場合に付与
                if top_color_score >= color_threshold and (top_color_score - second_color_score) >= 0.008:
                    results.append({
                        "tag": self.tags[top_color_idx],
                        "confidence": round(top_color_score, 3),
                        "category": self.categories[top_color_idx],
                    })

            return results
        except Exception as e:
            logger.error(f"AI prediction error: {e}")
            return []


def get_ai_tagger() -> AITagger:
    """シングルトンインスタンスを返すヘルパー"""
    return AITagger.get_instance()
