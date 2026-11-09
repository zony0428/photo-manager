using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Tetheract Photo Manager Launcher")]
[assembly: AssemblyDescription("Tetheract Photo Manager Standalone Desktop Launcher")]
[assembly: AssemblyCompany("Tetheract Project")]
[assembly: AssemblyProduct("Tetheract Photo Manager")]
[assembly: AssemblyCopyright("Copyright (c) 2026 Tetheract Project (MIT License)")]
[assembly: ComVisible(false)]
[assembly: AssemblyVersion("1.8.4.0")]
[assembly: AssemblyFileVersion("1.8.4.0")]

namespace PhotoManager
{
    /// <summary>
    /// Tetheract Photo Manager 専用ネイティブブートストラップランチャー
    /// ・黒いDOS窓を出さずにポータブルPythonとserver\run.pyをバックグラウンド起動
    /// ・同フォルダ内の差分更新ZIP (Tetheract_v*diff.zip) を検知して古いプログラムを一掃するクリーンアップデート
    /// ・従来の解凍上書きアップデート時にルート直下へ残った旧ファイル (Build.bat, start.bat, run.py, launcher/) の自動整理
    /// ・初回起動時およびアップデート時の autorun.inf 設置確認
    /// </summary>
    static class Launcher
    {
        private const int ServerPort = 8088;

        [STAThread]
        static void Main()
        {
            try
            {
                string baseDir = AppDomain.CurrentDomain.BaseDirectory;
                if (!baseDir.EndsWith("\\") && !baseDir.EndsWith("/"))
                {
                    baseDir += "\\";
                }

                // 1. 前回アップデート時の自己更新退避ファイル (Tetheract.exe.old) があれば削除
                CleanupOldExecutable(baseDir);

                // 2. 差分アップデートZIP (Tetheract_*diff.zip) の自動検知とクリーン適用
                bool updatedJustNow = CheckAndApplyUpdateZip(baseDir);

                // 2-b. 従来方式（ZIP解凍＋上書きコピー）で更新された配布環境の旧ルート残骸を自動整理
                CleanupLegacyRootClutter(baseDir);

                // 3. 初回起動時（またはアップデート直後）に autorun.inf が未設置なら確認
                bool isFirstRun = !File.Exists(Path.Combine(baseDir, @"cache\library.db")) &&
                                  !File.Exists(Path.Combine(baseDir, ".tetheract_instance"));
                if (updatedJustNow || isFirstRun)
                {
                    PromptAutorunIfNeeded(baseDir, updatedJustNow);
                }

                // 4. バックエンド起動スクリプトとポータブルPythonの探索
                string runPyServer = Path.Combine(baseDir, @"server\run.py");
                string runPyRoot = Path.Combine(baseDir, "run.py");
                string runPy = File.Exists(runPyServer) ? runPyServer : (File.Exists(runPyRoot) ? runPyRoot : null);
                string pywUsb = Path.Combine(baseDir, @"python\pythonw.exe");
                string pyUsb = Path.Combine(baseDir, @"python\python.exe");

                if (runPy == null)
                {
                    MessageBox.Show(
                        "起動スクリプト (server\\run.py) が見つかりません。\n配置場所を確認してください:\n" + baseDir,
                        "Tetheract Photo Manager 起動エラー",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error
                    );
                    return;
                }

                string pythonExe = null;
                if (File.Exists(pywUsb))
                {
                    pythonExe = pywUsb;
                }
                else if (File.Exists(pyUsb))
                {
                    pythonExe = pyUsb;
                }

                if (pythonExe == null)
                {
                    MessageBox.Show(
                        "ポータブルPythonが見つかりませんでした。\n\n" +
                        "フルパッケージ版を展開するか、setup_portable_python.bat を実行してポータブルPythonをセットアップしてください。",
                        "Tetheract Photo Manager - セットアップが必要です",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Warning
                    );
                    return;
                }

                // 5. Windowsシェル経由で完全独立プロセスとして起動
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = pythonExe;
                psi.Arguments = "\"" + runPy + "\"";
                psi.WorkingDirectory = baseDir;
                psi.UseShellExecute = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;

                Process.Start(psi);
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "Tetheract Photo Manager の起動に失敗しました:\n" + ex.Message,
                    "Tetheract Photo Manager 起動エラー",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
        }

        /// <summary>
        /// 前回の自己更新でリネーム退避された Tetheract.exe.old を削除する
        /// </summary>
        private static void CleanupOldExecutable(string baseDir)
        {
            string oldExe = Path.Combine(baseDir, "Tetheract.exe.old");
            if (!File.Exists(oldExe))
            {
                return;
            }
            for (int i = 0; i < 5; i++)
            {
                try
                {
                    File.Delete(oldExe);
                    break;
                }
                catch (Exception)
                {
                    Thread.Sleep(150);
                }
            }
        }

        /// <summary>
        /// 従来方式（ZIP解凍・上書きコピー）で更新された配布環境において、
        /// tools\ および server\run.py が揃っていればルート直下の旧残骸ファイルを自動整理する
        /// </summary>
        private static void CleanupLegacyRootClutter(string baseDir)
        {
            try
            {
                // 開発リポジトリ（build_dist.bat が存在する環境）では削除しない
                if (File.Exists(Path.Combine(baseDir, "build_dist.bat")))
                {
                    return;
                }
                // 新構成の tools\Launcher.cs と server\run.py が存在することを確認
                if (!File.Exists(Path.Combine(baseDir, @"tools\Launcher.cs")) ||
                    !File.Exists(Path.Combine(baseDir, @"server\run.py")))
                {
                    return;
                }

                string[] legacyRootFiles = new string[]
                {
                    "Build.bat",
                    "start.bat",
                    "run.py",
                    "PhotoManager.exe",
                    "PhotoManager_Mobile.html"
                };
                foreach (string fileName in legacyRootFiles)
                {
                    string filePath = Path.Combine(baseDir, fileName);
                    if (File.Exists(filePath))
                    {
                        try { File.Delete(filePath); } catch (Exception) { }
                    }
                }

                string legacyLauncherDir = Path.Combine(baseDir, "launcher");
                if (Directory.Exists(legacyLauncherDir))
                {
                    DeleteDirectoryRobust(legacyLauncherDir);
                }

                // 旧空フォルダ storage/ が空のまま残っている場合は削除して Loome/ を用意
                string legacyStorageDir = Path.Combine(baseDir, "storage");
                if (Directory.Exists(legacyStorageDir))
                {
                    string[] entries = Directory.GetFileSystemEntries(legacyStorageDir);
                    if (entries == null || entries.Length == 0)
                    {
                        try { Directory.Delete(legacyStorageDir, false); } catch (Exception) { }
                    }
                }
                string loomeDir = Path.Combine(baseDir, "Loome");
                if (!Directory.Exists(loomeDir) && !Directory.Exists(legacyStorageDir))
                {
                    try { Directory.CreateDirectory(loomeDir); } catch (Exception) { }
                }
                string takeoutDir = Path.Combine(baseDir, "take_out");
                if (!Directory.Exists(takeoutDir))
                {
                    try { Directory.CreateDirectory(takeoutDir); } catch (Exception) { }
                }
            }
            catch (Exception)
            {
            }
        }

        /// <summary>
        /// ルートフォルダに Tetheract_*diff.zip が置かれている場合、確認の上で古いプログラムフォルダを一掃してクリーン展開する
        /// </summary>
        private static bool CheckAndApplyUpdateZip(string baseDir)
        {
            string[] zipFiles;
            try
            {
                zipFiles = Directory.GetFiles(baseDir, "Tetheract_*diff.zip", SearchOption.TopDirectoryOnly);
            }
            catch (Exception)
            {
                return false;
            }

            if (zipFiles == null || zipFiles.Length == 0)
            {
                return false;
            }

            // 複数ある場合は最終更新日時が最も新しいZIPを選択
            Array.Sort(zipFiles, (a, b) => File.GetLastWriteTimeUtc(b).CompareTo(File.GetLastWriteTimeUtc(a)));
            string targetZip = zipFiles[0];
            string zipName = Path.GetFileName(targetZip);

            DialogResult confirm = MessageBox.Show(
                "アップデート用パッケージが見つかりました:\n" +
                "📦 " + zipName + "\n\n" +
                "古い不要ファイルを一掃して、クリーンアップデートを適用しますか？\n" +
                "（※ 登録済みの写真データ・Loome保管庫・データベースは一切消えません）",
                "Tetheract Photo Manager - クリーンアップデート",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question
            );

            if (confirm != DialogResult.Yes)
            {
                return false;
            }

            try
            {
                // 1. 削除前にZIPアーカイブが正常で必須ファイルを含んでいるか検証
                if (!ValidateUpdateZip(targetZip))
                {
                    MessageBox.Show(
                        "指定されたZIPファイルは有効な Tetheract アップデートパッケージではありません。\n" + zipName,
                        "アップデート中断",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Warning
                    );
                    return false;
                }

                // 2. サーバーが稼働中の場合は安全にシャットダウンさせる
                StopRunningServerIfNeeded();

                // 3. 古いプログラムフォルダおよび旧バージョンのルート残骸ファイルをクリーン削除
                string[] programDirs = new string[] { "frontend", "server", "LICENSES", "tools", "launcher" };
                foreach (string dirName in programDirs)
                {
                    string dirPath = Path.Combine(baseDir, dirName);
                    if (Directory.Exists(dirPath))
                    {
                        DeleteDirectoryRobust(dirPath);
                    }
                }

                string[] legacyRootFiles = new string[]
                {
                    "Build.bat",
                    "start.bat",
                    "run.py",
                    "PhotoManager.exe",
                    "PhotoManager_Mobile.html"
                };
                foreach (string fileName in legacyRootFiles)
                {
                    string filePath = Path.Combine(baseDir, fileName);
                    if (File.Exists(filePath))
                    {
                        try { File.Delete(filePath); } catch (Exception) { }
                    }
                }

                // 4. ZIPアーカイブの全エントリを展開（実行中の Tetheract.exe は .old へ退避して更新）
                ExtractUpdateZip(targetZip, baseDir);

                // 5. 適用済みの差分ZIPファイルを削除
                foreach (string zf in zipFiles)
                {
                    try { File.Delete(zf); } catch (Exception) { }
                }

                MessageBox.Show(
                    "クリーンアップデートが完了しました！ (" + zipName + ")\n" +
                    "古い不要ファイルを整理し、最新バージョンへ更新しました。",
                    "Tetheract Photo Manager - アップデート完了",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information
                );
                return true;
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "アップデート適用中にエラーが発生しました:\n" + ex.Message,
                    "Tetheract Photo Manager - アップデートエラー",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return false;
            }
        }

        /// <summary>
        /// アップデートZIP内に server/run.py と frontend/index.html が含まれているか検証する
        /// </summary>
        private static bool ValidateUpdateZip(string zipPath)
        {
            bool hasServerRun = false;
            bool hasFrontendIndex = false;
            using (ZipArchive archive = ZipFile.OpenRead(zipPath))
            {
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    string norm = entry.FullName.Replace('\\', '/').TrimStart('/');
                    if (string.Equals(norm, "server/run.py", StringComparison.OrdinalIgnoreCase))
                    {
                        hasServerRun = true;
                    }
                    else if (string.Equals(norm, "frontend/index.html", StringComparison.OrdinalIgnoreCase))
                    {
                        hasFrontendIndex = true;
                    }
                }
            }
            return hasServerRun && hasFrontendIndex;
        }

        /// <summary>
        /// 既存のTetheractサーバーがポート8088で稼働中であればシャットダウン要求を送り停止を待つ
        /// </summary>
        private static void StopRunningServerIfNeeded()
        {
            if (!IsPortInUse(ServerPort))
            {
                return;
            }

            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + ServerPort + "/api/shutdown");
                req.Method = "POST";
                req.Headers.Add("Origin", "http://127.0.0.1:" + ServerPort);
                req.ContentLength = 0;
                req.Timeout = 2000;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                }
            }
            catch (Exception)
            {
            }

            // ポートが解放されるまで最大6秒待機
            for (int i = 0; i < 30; i++)
            {
                if (!IsPortInUse(ServerPort))
                {
                    Thread.Sleep(200);
                    return;
                }
                Thread.Sleep(200);
            }
        }

        private static bool IsPortInUse(int port)
        {
            try
            {
                using (TcpClient client = new TcpClient())
                {
                    IAsyncResult result = client.BeginConnect("127.0.0.1", port, null, null);
                    bool success = result.AsyncWaitHandle.WaitOne(TimeSpan.FromMilliseconds(250));
                    if (success && client.Connected)
                    {
                        client.EndConnect(result);
                        return true;
                    }
                }
            }
            catch (Exception)
            {
            }
            return false;
        }

        /// <summary>
        /// ディレクトリをリトライ付きで確実に削除する
        /// </summary>
        private static void DeleteDirectoryRobust(string targetDir)
        {
            for (int i = 0; i < 5; i++)
            {
                try
                {
                    if (Directory.Exists(targetDir))
                    {
                        Directory.Delete(targetDir, true);
                    }
                    return;
                }
                catch (Exception)
                {
                    Thread.Sleep(250);
                }
            }
        }

        /// <summary>
        /// ZIPアーカイブを baseDir に展開する。実行中の Tetheract.exe 自身は .old にリネーム退避して置換する
        /// </summary>
        private static void ExtractUpdateZip(string zipPath, string baseDir)
        {
            string fullBaseDir = Path.GetFullPath(baseDir);
            string currentExePath = Path.Combine(fullBaseDir, "Tetheract.exe");
            string oldExePath = Path.Combine(fullBaseDir, "Tetheract.exe.old");

            using (ZipArchive archive = ZipFile.OpenRead(zipPath))
            {
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    string relPath = entry.FullName.Replace('/', Path.DirectorySeparatorChar).Replace('\\', Path.DirectorySeparatorChar);
                    string destPath = Path.GetFullPath(Path.Combine(fullBaseDir, relPath));

                    // パストラバーサル防止
                    if (!destPath.StartsWith(fullBaseDir, StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }

                    // ディレクトリエントリの場合
                    if (string.IsNullOrEmpty(entry.Name))
                    {
                        Directory.CreateDirectory(destPath);
                        continue;
                    }

                    string parentDir = Path.GetDirectoryName(destPath);
                    if (!string.IsNullOrEmpty(parentDir) && !Directory.Exists(parentDir))
                    {
                        Directory.CreateDirectory(parentDir);
                    }

                    // 実行中の Tetheract.exe 自身の更新時は .old へリネーム退避してから書き出す
                    if (string.Equals(destPath, currentExePath, StringComparison.OrdinalIgnoreCase) && File.Exists(currentExePath))
                    {
                        try
                        {
                            if (File.Exists(oldExePath))
                            {
                                File.Delete(oldExePath);
                            }
                            File.Move(currentExePath, oldExePath);
                        }
                        catch (Exception)
                        {
                        }
                    }

                    entry.ExtractToFile(destPath, true);
                }
            }
        }

        /// <summary>
        /// 初回起動時やアップデート完了時に autorun.inf が未設置であればユーザーに設置を確認する
        /// </summary>
        private static void PromptAutorunIfNeeded(string baseDir, bool isAfterUpdate)
        {
            string autorunPath = Path.Combine(baseDir, "autorun.inf");
            if (File.Exists(autorunPath))
            {
                return;
            }

            string header = isAfterUpdate
                ? "アップデート後の確認:\n\n"
                : "初回起動の確認:\n\n";

            DialogResult dr = MessageBox.Show(
                header +
                "エクスプローラーでドライブに TETHERACT アイコンと名称を表示するための「autorun.inf」を設置しますか？\n\n" +
                "・USBメモリや外付けSSDのルート階層で使う場合におすすめです。\n" +
                "・一部のウイルス対策ソフトが autorun.inf に警告を出す環境では「いいえ」を選択してください。",
                "Tetheract Photo Manager - autorun.inf の設置",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question
            );

            if (dr == DialogResult.Yes)
            {
                try
                {
                    string content = "[AutoRun]\r\nicon=frontend\\favicon.ico,0\r\nlabel=TETHERACT pm\r\n";
                    File.WriteAllText(autorunPath, content, Encoding.ASCII);
                }
                catch (Exception ex)
                {
                    MessageBox.Show(
                        "autorun.inf の作成に失敗しました:\n" + ex.Message,
                        "Tetheract Photo Manager",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Warning
                    );
                }
            }
        }
    }
}
