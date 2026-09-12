using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.IO.Pipes;

internal sealed class JobHandle : IDisposable {
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits { internal long PerProcess, PerJob; internal uint Flags; internal UIntPtr MinimumWorkingSet, MaximumWorkingSet; internal uint ActiveProcesses; internal UIntPtr Affinity; internal uint Priority, Scheduling; }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { internal ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits { internal BasicLimits Basic; internal IoCounters Io; internal UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct StartupInfo { internal uint Size; internal string Reserved, Desktop, Title; internal uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags; internal ushort ShowWindow, Reserved2; internal IntPtr ReservedPtr, Input, Output, Error; }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInfo { internal IntPtr Process, Thread; internal uint Pid, Tid; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref ExtendedLimits limits, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] private static extern bool TerminateProcess(IntPtr process, uint code);
    private IntPtr handle;
    internal JobHandle() {
        handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero) throw new Win32Exception();
        var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE; no breakaways.
        if (!SetInformationJobObject(handle, 9, ref limits, (uint)Marshal.SizeOf(limits))) { Dispose(); throw new Win32Exception(); }
    }
    internal static string Quote(string text) {
        if (text.IndexOf('\0') >= 0) throw new InvalidDataException("NUL in process argument.");
        var output = new StringBuilder("\""); int slashes = 0;
        foreach (char c in text) { if (c == '\\') { slashes++; continue; } if (c == '"') output.Append('\\', slashes * 2 + 1); else output.Append('\\', slashes); output.Append(c); slashes = 0; }
        return output.Append('\\', slashes * 2).Append('"').ToString();
    }
    internal Process Launch(string executable, IEnumerable<string> arguments, string workingDirectory, IntPtr input, IntPtr output, IntPtr error) {
        var command = new StringBuilder(Quote(executable)); foreach (string argument in arguments) command.Append(' ').Append(Quote(argument));
        var startup = new StartupInfo { Size = (uint)Marshal.SizeOf(typeof(StartupInfo)), Flags = 0x100, Input = input, Output = output, Error = error };
        ProcessInfo process;
        if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x4 | 0x08000000, IntPtr.Zero, workingDirectory, ref startup, out process)) throw new Win32Exception();
        try {
            // Assignment precedes the very first instruction of the child.
            if (!AssignProcessToJobObject(handle, process.Process)) throw new Win32Exception();
            if (ResumeThread(process.Thread) == UInt32.MaxValue) throw new Win32Exception();
            return Process.GetProcessById((int)process.Pid);
        } catch { TerminateProcess(process.Process, 1); throw; }
        finally { CloseHandle(process.Thread); CloseHandle(process.Process); }
    }
    internal void Terminate() { if (handle != IntPtr.Zero && !TerminateJobObject(handle, 0)) throw new Win32Exception(); }
    public void Dispose() { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
}

internal static class ManagedJob {
    private static void PumpBrowser(Stream stream) {
        var thread = new Thread(() => {
            try {
                using (var message = new MemoryStream()) {
                    int value;
                    while ((value = stream.ReadByte()) >= 0) {
                        if (value == 0) {
                            if (message.Length > 0) Json.Emit(new { type = "browser-message", message = Json.Decode(Encoding.UTF8.GetString(message.ToArray())) });
                            message.SetLength(0);
                        } else {
                            if (message.Length >= 1048576) throw new IOException("Oversized browser control response.");
                            message.WriteByte((byte)value);
                        }
                    }
                }
            } catch (Exception) { /* No page data or credentials in diagnostics. */ }
            finally { Program.StopRequested = true; }
        });
        thread.IsBackground = true; thread.Start();
    }
    private static void Pump(Stream stream, bool forward) {
        var thread = new Thread(() => { try { using (var reader = new StreamReader(stream, Encoding.UTF8)) { string line; while ((line = reader.ReadLine()) != null) if (forward) { lock (Json.OutputLock) { Console.WriteLine(line); Console.Out.Flush(); } } } } catch (IOException) { } });
        thread.IsBackground = true; thread.Start();
    }
    internal static void RemoveTemporaryDirectory(string directory) {
        string full = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar);
        string parent = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar);
        if (!String.Equals(Path.GetDirectoryName(full), parent, StringComparison.OrdinalIgnoreCase) ||
            !(Path.GetFileName(full).StartsWith("cherry-toolbox-isolated-browser-", StringComparison.Ordinal) || Path.GetFileName(full).StartsWith("cherry-toolbox-routing-", StringComparison.Ordinal))) throw new IOException("Unsafe temporary directory.");
        if (!Directory.Exists(full)) return;
        if ((File.GetAttributes(full) & FileAttributes.ReparsePoint) != 0) throw new IOException("Refusing a reparse point.");
        RemoveTree(full);
    }
    private static void RemoveTree(string directory) {
        foreach (string file in Directory.GetFiles(directory)) File.Delete(file);
        foreach (string child in Directory.GetDirectories(directory)) {
            if ((File.GetAttributes(child) & FileAttributes.ReparsePoint) != 0) Directory.Delete(child, false);
            else RemoveTree(child);
        }
        Directory.Delete(directory, false);
    }
    internal static int Run(Dictionary<string, object> configuration) {
        string executable = Path.GetFullPath(Json.Text(configuration, "executable"));
        string directory = Path.GetFullPath(Json.Text(configuration, "workingDirectory"));
        object raw; if (!configuration.TryGetValue("arguments", out raw) || !(raw is object[])) throw new InvalidDataException("Invalid process arguments.");
        var arguments = new List<string>(); foreach (object item in (object[])raw) { if (!(item is string)) throw new InvalidDataException("Invalid process argument."); arguments.Add((string)item); }
        if (!File.Exists(executable)) throw new FileNotFoundException("The managed executable is missing.");
        // This supervisor is never elevated; it cannot grant privileges to a child.
        if (new System.Security.Principal.WindowsPrincipal(System.Security.Principal.WindowsIdentity.GetCurrent()).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator)) throw new InvalidOperationException("Managed browsing must run without administrator privileges.");
        object initialInput; configuration.TryGetValue("initialInput", out initialInput);
        object forwardOutput; configuration.TryGetValue("forwardOutput", out forwardOutput);
        object browserPipeValue; configuration.TryGetValue("browserPipe", out browserPipeValue);
        bool browserPipe = browserPipeValue is bool && (bool)browserPipeValue;
        using (var input = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.Inheritable))
        using (var output = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable))
        using (var error = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable))
        using (var browserInput = browserPipe ? new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.Inheritable) : null)
        using (var browserOutput = browserPipe ? new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable) : null)
        using (var job = new JobHandle()) {
            if (browserPipe) {
                if (!arguments.Contains("--remote-debugging-pipe") || arguments.Exists(value => value.StartsWith("--remote-debugging-port", StringComparison.Ordinal) || value.StartsWith("--remote-debugging-io-pipes", StringComparison.Ordinal))) throw new InvalidDataException("Only private browser control pipes are allowed.");
                arguments.Add("--remote-debugging-io-pipes=" + browserInput.GetClientHandleAsString() + "," + browserOutput.GetClientHandleAsString());
            }
            using (var child = job.Launch(executable, arguments, directory, input.ClientSafePipeHandle.DangerousGetHandle(), output.ClientSafePipeHandle.DangerousGetHandle(), error.ClientSafePipeHandle.DangerousGetHandle())) {
                input.DisposeLocalCopyOfClientHandle(); output.DisposeLocalCopyOfClientHandle(); error.DisposeLocalCopyOfClientHandle();
                if (browserPipe) { browserInput.DisposeLocalCopyOfClientHandle(); browserOutput.DisposeLocalCopyOfClientHandle(); PumpBrowser(browserOutput); }
                Json.Emit(new { type = "helper-ready", pid = child.Id, createdAt = child.StartTime.ToUniversalTime().ToString("o") });
                Pump(output, forwardOutput is bool && (bool)forwardOutput); Pump(error, false);
                using (var writer = new StreamWriter(input, new UTF8Encoding(false))) {
                writer.AutoFlush = true;
                if (initialInput != null) writer.WriteLine(Json.Encode(initialInput));
                Program.ReadControl(value => {
                    if (!browserPipe || Json.Text(value, "type") != "browser-command") throw new InvalidDataException("Unsupported supervisor command.");
                    string message = Json.Text(value, "message"); Json.Decode(message);
                    byte[] bytes = Encoding.UTF8.GetBytes(message + "\0");
                    browserInput.Write(bytes, 0, bytes.Length); browserInput.Flush();
                });
                while (!Program.StopRequested && Program.HeartbeatAge <= 10 && !child.HasExited) Thread.Sleep(100);
                job.Terminate();
                if (!child.WaitForExit(8000)) throw new IOException("Managed process did not exit.");
                }
            }
        }
        object cleanup; if (configuration.TryGetValue("cleanupDirectory", out cleanup) && cleanup is string) {
            Exception last = null;
            for (int attempt = 0; attempt < 20; attempt++) { try { RemoveTemporaryDirectory((string)cleanup); last = null; break; } catch (IOException failure) { last = failure; Thread.Sleep(500); } }
            if (last != null) throw last;
        }
        Json.Emit(new { type = "stopped" }); return 0;
    }
}
