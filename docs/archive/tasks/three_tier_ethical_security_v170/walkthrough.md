# v1.7.0 3段階セキュリティ＆エシカル保護・セルフブリック完全防止 実装＆監査記録

## 1. 背景と目的

Tetheract Photo Manager を USB メモリや外付け SSD で持ち歩くポータブル運用において、以下の課題・要件を解決するため、v1.7.0 にて **3段階セキュリティ＆エシカル保護モデル（Lv.0 / Lv.1 / Lv.2）** を設計・実装した。

1. **エシカル（倫理的）な境界保護（パスワード不要・既定で常時有効）**:
   - 友人や同僚から借りた外付けドライブに相手の `Loome` が存在する場合、無断で閲覧したり、そのドライブを管理下に置いたり、`Loome` を上書き作成することをシステムレベルで完全拒否する（ただし自分の別PCで作った `Loome` は同じパスワードまたはリカバリーコードで承認・統合できる）。
   - `cache/library.db` だけが単体で引き抜かれて別の Tetheract 環境に差し込まれた場合、パスワード未設定（Lv.0）であってもそのままサムネイルやメタデータが見えてしまわないよう本体個体鍵（`.tetheract_instance`）とのペアリングを検証し、不一致時はロックする。
   - 本体入り USB メモリが突然故障し、バックアップしていた `library.db` を新しい Tetheract 本体へ引き継ぐ際には、①パスワード、②所有メディア（VSN＋実在写真ファイルサイズ照合）、③16桁リカバリーコード（`TETH-XXXX-XXXX-XXXX-XXXX`）の3通りの救済手段を提供する。
2. **パスワードによる起動ロック＆DBサムネイル暗号化（Lv.1）と `Loome` カプセル化ロック（Lv.2）**:
   - **Lv.1**: アプリ起動時のパスワードロック画面（全データAPI `423 Locked` 遮断）＋ 2段階鍵方式（256-bit `DEK` + `PBKDF2-HMAC-SHA256` 200,000反復 `KEK`）による `thumbnails.data` BLOB の AEAD 暗号化（`TENC\x01`）＋ `VACUUM` 平文ページ消去。
   - **Lv.2**: Lv.1 に加え、`Loome/`（本体および外付け）内の画像・RAWファイルの先頭最大64KBをインプレース暗号化（先頭8B `TETHVLT1` マジック置換 ＋ 末尾72B認証フッター付与）し、OSエクスプローラー等からの直接閲覧を遮断。解錠中はオンメモリで透過復号し、スマート・テイクアウトや外部書き出し時には元の無加工ファイルへ1ビット単位で完全復元する。

---

## 2. Red Team vs Blue Team サブエージェント相互批判監査と対策

実装完了後、「今後の差分VerUPや誤操作で鍵が行方不明になり、自分の写真すら復号できなくなるセルフブリック（自爆ロック）の死角はないか」を検証するため、**Red Team（破壊的セキュリティ＆アップデート批判官）** と **Blue Team（ポータブル運用＆フェイルセーフ設計監査官）** の2体のサブエージェントによる徹底監査を実施し、以下の6つの死角をすべて潰した。

| # | 監査で発掘された死角（Red Team / Blue Team 指摘） | 実装したフェイルセーフ対策 | 該当コード |
| :--- | :--- | :--- | :--- |
| **1** | **Lv.2 運用中に `cache/library.db` を誤削除・紛失して再起動した際の旧DEK上書き抹殺**<br>新規DBとして新しい乱数 `DEK_B` が生成され、その後 Lv.2 を再設定すると `Loome/.loome_seal` が新 `DEK_B` で上書きされ、既存暗号化写真を復号するための旧 `DEK_A` が消滅する。 | 1. `write_loome_seal()` で `.loome_seal` にパスワードラップ・リカバリーコードラップ・個体鍵ラップ・`security_level` をすべて格納し、既存シールに別鍵があれば `previous_seals` 配列（最大10世代）に履歴退避して絶対に消去しない。<br>2. `initialize_security_state()` で `library.db` の `security_meta` が空のとき、新規乱数を作る前に本体 `Loome/.loome_seal` から鍵メタデータを自動サルベージ（`_try_salvage_meta_from_internal_loome_seal`）する。 | `server/security.py`<br>`write_loome_seal()`,<br>`_try_salvage_meta_from_internal_loome_seal()` |
| **2** | **Lv.0 でフル版ZIP展開フォルダへ `cache/` と `Loome/` を手動引っ越しした際の `.tetheract_instance` コピー漏れ**<br>隠しファイルの `.tetheract_instance` をコピーし忘れると、Lv.0 なのに引っ越し先で引き抜きロック画面が出る。 | Lv.0 の本体 `Loome/.loome_seal` に `lv0_cohesion_bundle` を記録。`.tetheract_instance` が未知でも、同じ本体フォルダ内に `library.db` と一致する `owner_id`・HMAC署名を持つ `Loome/.loome_seal` がセットで存在すれば、正当な引っ越しと判定して新 `.tetheract_instance` を自動ペアリングする（`library.db` 単体引き抜き時は `.loome_seal` が無いため確実にロック）。 | `server/security.py`<br>`_try_auto_pair_lv0_by_internal_loome_seal()` |
| **3** | **重複写真統合・Loome移動後のサムネイル `photo_id` (AAD) 不整合による Lv.0 解除不能バグ**<br>SQL で `thumbnails.data` が別 `photo_id` にコピーされると `aad=str(photo_id)` が不一致になり、Lv.0 への復号マイグレーションが `ValueError` で停止する。 | 固定AAD（`THUMB_AAD = b"TETH_THUMB_V1"`）を採用し、復号時は「固定AAD ➔ 旧 `photo_id` AAD ➔ 空AAD」の3段階で後方互換フォールバック検証。さらに復号不能な破損キャッシュ行はマイグレーション時に自動削除（次回表示時に再生成）して確実に完走させる。 | `server/security.py`<br>`encrypt_thumbnail_blob()`,<br>`decrypt_thumbnail_blob()`,<br>`_migrate_thumbnails_encryption()` |
| **4** | **Lv.2 カプセル化ファイルに対する `compute_file_sample_hash` / `has_exif_datetime` の不整合**<br>ディスク上の生ファイルを直接読むと、先頭64KBが暗号化されているため平文時とハッシュ値やExif判定が変わってしまう。 | `is_vault_encrypted_file()` 検知時は論理ファイルサイズ（`-72B`）と `read_loome_file_decrypted_bytes()` を使用するよう修正し、平文時と1ビット単位で同じハッシュ値・Exif判定結果を保証。 | `server/scanner.py`<br>`compute_file_sample_hash()`,<br>`has_exif_datetime()` |
| **5** | **マイグレーション途中の電源断による鍵未保存・フッター破損**<br>全ファイル暗号化後にDBへパスワードラップを保存すると、途中クラッシュ時に鍵が残らない。 | 1. **Step 0（Write-Ahead Key Commit）**: マイグレーション開始前に `security_meta` と `.loome_seal` へパスワードラップを先行コミット。<br>2. **フッター先行フラッシュ**: `seal_loome_file()` で末尾72Bフッターを先に `flush()` してから先頭64KBを上書きし、未完了フッターも次回HMAC検証で自動クリーンアップ。 | `server/security.py`<br>`configure_security_level()`,<br>`seal_loome_file()` |
| **6** | **起動時の DB 競合（`SQLITE_BUSY`）とフロントエンド 423 レースコンディション**<br>起動直後の `_bg_backfill_lenses` や全スレッド接続が残った状態での `VACUUM`、およびロック解除前のフロントエンド API 呼び出し。 | 1. `close_all_connections()` で全スレッド接続を閉じてから `VACUUM` 実行。<br>2. `_bg_backfill_lenses` は `is_app_locked() == False` まで待機。<br>3. `frontend/js/app.js` で `await initSecurityGateOnStartup()` 完了後にのみフォルダ・ギャラリー・SSEを開始。 | `server/database/connection.py`,<br>`server/app.py`,<br>`frontend/js/app.js`,<br>`frontend/js/common.js` |

---

## 3. 検証結果

- **全自動回帰テスト（`test_core_regression.py` + `test_security.py`）**: 全 43 テスト合格（`Ran 43 tests in 4.465s - OK`）
- **本番 `cache/library.db` コピーでの起動・ペアリング・引き抜き検知・所有メディアVSN自動復旧シミュレーション**: 全項目合格
