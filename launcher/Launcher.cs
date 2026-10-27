using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;

[assembly: AssemblyTitle("Photo Manager Launcher")]
[assembly: AssemblyDescription("Photo Manager Standalone Desktop Launcher")]
[assembly: AssemblyCompany("Photo Manager Project")]
[assembly: AssemblyProduct("Photo Manager")]
[assembly: AssemblyCopyright("Copyright (c) 2026 Photo Manager Project (MIT License)")]
[assembly: ComVisible(false)]
[assembly: AssemblyVersion("3.0.2.0")]
[assembly: AssemblyFileVersion("3.0.2.0")]

namespace PhotoManager
{
    /// <summary>
    /// Photo Manager 専用ネイティブブートストラップランチャー
    /// 黒いDOS窓を出さずにポータブルPythonとrun.pyをバックグラウンド起動します。
    /// </summary>
    static class Launcher
    {
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
                string runPyServer = Path.Combine(baseDir, @"server\run.py");
                string runPyRoot = Path.Combine(baseDir, "run.py");
                string runPy = File.Exists(runPyServer) ? runPyServer : (File.Exists(runPyRoot) ? runPyRoot : null);
                string pywUsb = Path.Combine(baseDir, @"python\pythonw.exe");
                string pyUsb = Path.Combine(baseDir, @"python\python.exe");

                if (runPy == null)
                {
                    MessageBox.Show(
                        "run.py が見つかりません。\n配置場所（server\\run.py または run.py）を確認してください:\n" + baseDir,
                        "Photo Manager 起動エラー",
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
                        "USBメモリで持ち歩き利用する場合は、\n" +
                        "「setup_portable_python.bat」を実行してポータブルPythonをセットアップしてください。",
                        "Photo Manager - セットアップが必要です",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Warning
                    );
                    return;
                }

                // Windowsシェル経由で完全独立プロセスとして起動（start.bat と同等の確実性）
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
                    "Photo Manager の起動に失敗しました:\n" + ex.Message,
                    "Photo Manager 起動エラー",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
        }
    }
}
