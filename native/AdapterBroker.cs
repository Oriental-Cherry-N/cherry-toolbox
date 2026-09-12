using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Management;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

internal sealed class AdapterRecord {
    public string adapterId;
    public bool originalEnabled;
    public bool requestedEnabled;
}

internal static class AdapterBroker {
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetNamedPipeClientProcessId(SafePipeHandle pipe, out uint processId);
    private static readonly SecurityIdentifier Admins = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
    private static readonly SecurityIdentifier SystemSid = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
    internal const string Protocol = "cherry-adapter-v2";
    private static Mutex RecoveryMutex(string sid) { return new Mutex(false, "Global\\CherryToolboxAdapterRecovery-" + sid); }
    private static bool Acquire(Mutex mutex) { try { return mutex.WaitOne(0); } catch (AbandonedMutexException) { return true; } }
    internal static int RecoveryStatus() {
        string sid = WindowsIdentity.GetCurrent().User.Value;
        string file = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "CherryToolboxAdapterRecovery", sid, "pending.json");
        using (var mutex = RecoveryMutex(sid)) {
            // An empty file while a broker is alive does not rule out an admitted apply.
            if (!Acquire(mutex)) { Json.Emit(new { pending = true, active = true }); return 0; }
            try {
                try {
                    var records = ParseRecords(Json.Decode(File.ReadAllText(file)));
                    Json.Emit(new { pending = records.Count > 0, active = false });
                } catch (DirectoryNotFoundException) { Json.Emit(new { pending = false, active = false }); }
                  catch (FileNotFoundException) { if (File.Exists(file + ".previous")) throw new IOException("The privileged recovery primary is missing; original states require review."); Json.Emit(new { pending = false, active = false }); }
            } finally { mutex.ReleaseMutex(); }
        }
        return 0;
    }

    internal static void WaitForParent(NamedPipeServerStream pipe, int timeoutMilliseconds) {
        var connection = pipe.BeginWaitForConnection(null, null);
        using (var wait = connection.AsyncWaitHandle) {
            if (!wait.WaitOne(timeoutMilliseconds)) throw new IOException("The authenticated parent did not connect.");
            pipe.EndWaitForConnection(connection);
        }
    }

    internal static void AuthenticateParent(NamedPipeServerStream pipe, int parentId, string sid) {
        uint clientId;
        if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle, out clientId) || clientId != (uint)parentId) throw new IOException("The broker rejected a different client process.");
        // ImpersonateNamedPipeClient requires a message to have been read first.
        // Bound both the size and duration before accepting any adapter command.
        var bytes = new byte[4096]; int used = 0;
        var deadline = Stopwatch.StartNew();
        while (true) {
            int remaining = 10000 - (int)deadline.ElapsedMilliseconds;
            if (remaining <= 0) throw new IOException("The client did not send its adapter handshake.");
            var read = pipe.BeginRead(bytes, used, bytes.Length - used, null, null);
            int count;
            using (var wait = read.AsyncWaitHandle) {
                if (!wait.WaitOne(remaining)) throw new IOException("The client did not send its adapter handshake.");
                count = pipe.EndRead(read);
            }
            if (count == 0) throw new IOException("The client disconnected during adapter authentication.");
            used += count;
            int newline = Array.IndexOf(bytes, (byte)'\n', 0, used);
            if (newline >= 0) {
                if (newline != used - 1) throw new IOException("Adapter commands cannot precede authentication.");
                var hello = Json.Decode(Encoding.UTF8.GetString(bytes, 0, newline));
                if (Json.Text(hello, "type") != "hello" || Json.Text(hello, "protocol") != Protocol) throw new IOException("The adapter handshake protocol is incompatible. Restart the updated application.");
                break;
            }
            if (used == bytes.Length) throw new IOException("The adapter handshake is too large.");
        }
        bool identity = false; pipe.RunAsClient(() => { identity = WindowsIdentity.GetCurrent().User.Value == sid; });
        if (!identity) throw new IOException("The broker rejected a different account.");
        Interlocked.Exchange(ref Program.LastHeartbeat, Stopwatch.GetTimestamp());
    }
    internal static int Elevate(string[] args) {
        if (args.Length != 2 || !args[0].StartsWith("cherry-adapter-", StringComparison.Ordinal) || args[0].Length != 47) throw new IOException("Invalid broker identity.");
        int parentId = Int32.Parse(args[1]);
        using (var parent = Process.GetProcessById(parentId)) {
            string executable = Process.GetCurrentProcess().MainModule.FileName;
            using (var executableLock = new FileStream(executable, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                var start = new ProcessStartInfo(executable, "adapter " + args[0] + " " + parentId + " " + parent.StartTime.ToUniversalTime().Ticks + " " + WindowsIdentity.GetCurrent().User.Value);
                start.UseShellExecute = true; start.Verb = "runas"; start.WindowStyle = ProcessWindowStyle.Hidden;
                using (var child = Process.Start(start)) { if (child == null) throw new IOException("The administrator broker could not start."); }
            }
        }
        return 0;
    }
    private static void SecureDirectory(string directory, SecurityIdentifier user) {
        if (Directory.Exists(directory)) {
            if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) throw new IOException("Recovery storage cannot be a reparse point.");
            var existing = Directory.GetAccessControl(directory);
            var owner = (SecurityIdentifier)existing.GetOwner(typeof(SecurityIdentifier));
            if (!owner.Equals(Admins) && !owner.Equals(SystemSid)) throw new IOException("Recovery storage has an untrusted owner.");
            foreach (FileSystemAccessRule rule in existing.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
                var who = (SecurityIdentifier)rule.IdentityReference;
                if (rule.AccessControlType == AccessControlType.Allow && !who.Equals(Admins) && !who.Equals(SystemSid) && (rule.FileSystemRights & (FileSystemRights.Write | FileSystemRights.Delete | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership)) != 0) throw new IOException("Recovery storage is writable by an unprivileged account.");
            }
            return;
        }
        var security = new DirectorySecurity(); security.SetAccessRuleProtection(true, false); security.SetOwner(Admins);
        foreach (var sid in new[] { Admins, SystemSid }) security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        if (user != null) security.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.ReadAndExecute, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        Directory.CreateDirectory(directory, security);
    }
    private static string StorePath(string sid) {
        string root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "CherryToolboxAdapterRecovery");
        SecureDirectory(root, null); string directory = Path.Combine(root, sid); SecureDirectory(directory, new SecurityIdentifier(sid)); return Path.Combine(directory, "pending.json");
    }
    private static void Persist(string path, Dictionary<string, AdapterRecord> records) {
        string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        byte[] bytes = Encoding.UTF8.GetBytes(Json.Encode(new { version = 1, records = records.Values.OrderBy(value => value.adapterId).ToArray() }));
        using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) { file.Write(bytes, 0, bytes.Length); file.Flush(true); }
        if (File.Exists(path)) File.Replace(temporary, path, path + ".previous"); else File.Move(temporary, path);
        // The primary is authoritative. Never recover an older backup as a latest record.
        if (!File.ReadAllBytes(path).SequenceEqual(bytes)) throw new IOException("The privileged recovery record could not be verified.");
    }
    private static List<AdapterRecord> ParseRecords(Dictionary<string, object> command) {
        object raw; if (!command.TryGetValue("records", out raw) || !(raw is object[]) || ((object[])raw).Length > 64) throw new IOException("Invalid adapter records.");
        var result = new List<AdapterRecord>();
        foreach (object value in (object[])raw) {
            var item = value as Dictionary<string, object>; if (item == null) throw new IOException("Invalid adapter record.");
            string id = Json.Text(item, "adapterId"); Guid guid;
            if (!id.StartsWith("guid:", StringComparison.Ordinal) || !Guid.TryParseExact(id.Substring(5), "D", out guid)) throw new IOException("A stable adapter GUID is required.");
            id = "guid:" + guid.ToString("D").ToUpperInvariant();
            if (result.Any(entry => entry.adapterId == id)) throw new IOException("Duplicate adapter GUID.");
            result.Add(new AdapterRecord { adapterId = id, originalEnabled = Json.Boolean(item, "originalEnabled"), requestedEnabled = Json.Boolean(item, "requestedEnabled") });
        }
        return result;
    }
    private static ManagementObject FindAdapter(string id) {
        string guid = new Guid(id.Substring(5)).ToString("B");
        using (var query = new ManagementObjectSearcher("root\\cimv2", "SELECT * FROM Win32_NetworkAdapter WHERE GUID = '" + guid + "'")) {
            var values = query.Get().Cast<ManagementObject>().ToArray();
            if (values.Length != 1) { foreach (var value in values) value.Dispose(); throw new IOException("The recorded network adapter is unavailable: " + id); }
            return values[0];
        }
    }
    private static bool Enabled(ManagementObject adapter) {
        // ConfigManagerErrorCode 22 is administratively disabled. Link-down is still enabled.
        object error = adapter["ConfigManagerErrorCode"];
        if (error == null) throw new IOException("Adapter administration status is unknown.");
        int code = Convert.ToInt32(error); if (code == 22) return false; if (code == 0) return true;
        throw new IOException("The adapter has a device error: " + code);
    }
    private static void Guard(ManagementObject adapter, bool enabled) {
        foreach (string name in new[] { "ChatGPT", "ChatGPT.Windows", "OpenAI.ChatGPT" }) {
            var processes = Process.GetProcessesByName(name); bool running = processes.Length > 0; foreach (var process in processes) process.Dispose();
            if (running) throw new IOException("Close the protected ChatGPT client before changing an adapter.");
        }
        if (!enabled && Convert.ToInt32(adapter["NetConnectionStatus"] ?? -1) == 2) {
            using (var query = new ManagementObjectSearcher("root\\cimv2", "SELECT GUID, NetConnectionStatus, ConfigManagerErrorCode FROM Win32_NetworkAdapter WHERE NetConnectionStatus = 2")) {
                bool alternative = false;
                foreach (ManagementObject item in query.Get()) using (item) { if (!String.Equals((string)item["GUID"], (string)adapter["GUID"], StringComparison.OrdinalIgnoreCase) && Enabled(item)) alternative = true; }
                if (!alternative) throw new IOException("The last connected network adapter cannot be disabled.");
            }
        }
    }
    private static void Set(AdapterRecord record, bool enabled, bool guard) {
        using (var adapter = FindAdapter(record.adapterId)) {
            if (guard) Guard(adapter, enabled);
            if (Enabled(adapter) != enabled) { uint result = Convert.ToUInt32(adapter.InvokeMethod(enabled ? "Enable" : "Disable", null)); if (result != 0) throw new IOException("Windows rejected the adapter change: " + result); }
        }
        for (int i = 0; i < 30; i++) { using (var adapter = FindAdapter(record.adapterId)) if (Enabled(adapter) == enabled) return; Thread.Sleep(100); }
        throw new IOException("The adapter change could not be verified.");
    }
    internal static List<Exception> RestoreEach(IEnumerable<AdapterRecord> records, Action<AdapterRecord> restore) {
        var errors = new List<Exception>(); foreach (var record in records) { try { restore(record); } catch (Exception error) { errors.Add(error); } } return errors;
    }
    private static void RestoreUntilSuccessful(string store, Dictionary<string, AdapterRecord> records, Action<string> report) {
        if (records.Count == 0) return;
        while (true) {
            var errors = RestoreEach(records.Values.ToArray(), record => Set(record, record.originalEnabled, false));
            if (errors.Count == 0) {
                try { Persist(store, new Dictionary<string, AdapterRecord>()); records.Clear(); return; }
                catch (Exception error) { errors.Add(error); }
            }
            report(String.Join("; ", errors.Select(error => error.Message))); Thread.Sleep(2000);
        }
    }
    internal static int RunElevated(string[] args) {
        if (args.Length != 4 || !args[0].StartsWith("cherry-adapter-", StringComparison.Ordinal) || args[0].Length != 47) throw new IOException("Invalid broker arguments.");
        if (!new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator)) throw new IOException("Administrator privileges are required.");
        int parentId = Int32.Parse(args[1]); long parentTicks = Int64.Parse(args[2]); string sid = new SecurityIdentifier(args[3]).Value;
        var mutex = RecoveryMutex(sid);
        bool acquired = Acquire(mutex);
        if (!acquired) { mutex.Dispose(); throw new IOException("An independent recovery broker is already restoring this account."); }
        try {
            string store = StorePath(sid); var records = new Dictionary<string, AdapterRecord>();
            if (File.Exists(store)) foreach (var record in ParseRecords(Json.Decode(File.ReadAllText(store)))) records.Add(record.adapterId, record);
            if (records.Count > 0) RestoreUntilSuccessful(store, records, _ => { });
            var security = new PipeSecurity(); security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(sid), PipeAccessRights.ReadWrite, AccessControlType.Allow));
            security.AddAccessRule(new PipeAccessRule(Admins, PipeAccessRights.FullControl, AccessControlType.Allow));
            using (var parent = Process.GetProcessById(parentId)) {
                if (parent.StartTime.ToUniversalTime().Ticks != parentTicks) throw new IOException("The parent process identity changed.");
                using (var pipe = new NamedPipeServerStream(args[0], PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 65536, 65536, security)) {
                    WaitForParent(pipe, 15000);
                    using (var reader = new StreamReader(pipe, Encoding.UTF8)) using (var writer = new StreamWriter(pipe, new UTF8Encoding(false))) {
                        writer.AutoFlush = true;
                        Action<object> send = value => { lock (writer) { try { writer.WriteLine(Json.Encode(value)); } catch (IOException) { Program.StopRequested = true; } } };
                        try { AuthenticateParent(pipe, parentId, sid); }
                        catch (Exception error) { send(new { type = "error", phase = "handshake", message = error.Message, code = error.HResult & 0xffff }); return 1; }
                        send(new { type = "ready", protocol = Protocol, pid = Process.GetCurrentProcess().Id });
                        var commands = new System.Collections.Concurrent.ConcurrentQueue<Dictionary<string, object>>();
                        var readThread = new Thread(() => { try { string line; while ((line = reader.ReadLine()) != null) { var command = Json.Decode(line); if (Json.Text(command, "type") == "heartbeat") Interlocked.Exchange(ref Program.LastHeartbeat, Stopwatch.GetTimestamp()); else commands.Enqueue(command); } } catch (Exception) { } finally { Program.StopRequested = true; } }); readThread.IsBackground = true; readThread.Start();
                        try {
                            while (!Program.StopRequested && !parent.HasExited && Program.HeartbeatAge <= 10) {
                                Dictionary<string, object> command;
                                if (!commands.TryDequeue(out command)) { Thread.Sleep(100); continue; }
                                string id = Json.Text(command, "id"), type = Json.Text(command, "type");
                                if (type == "restore") { RestoreUntilSuccessful(store, records, error => send(new { type = "recovering", message = error })); send(new { type = "result", id = id }); return 0; }
                                if (type != "apply") throw new IOException("Only structured adapter apply/restore commands are allowed.");
                                var requested = ParseRecords(command);
                                foreach (var record in requested) {
                                    AdapterRecord existing;
                                    using (var adapter = FindAdapter(record.adapterId)) {
                                        Guard(adapter, record.requestedEnabled);
                                        if (records.TryGetValue(record.adapterId, out existing)) { if (existing.originalEnabled != record.originalEnabled) throw new IOException("The original adapter state cannot change."); }
                                        else if (Enabled(adapter) != record.originalEnabled) throw new IOException("The adapter changed before its recovery snapshot was committed.");
                                    }
                                }
                                foreach (var record in requested) records[record.adapterId] = record;
                                Persist(store, records); // Must be durable before the first mutation.
                                foreach (var record in requested) { if (parent.HasExited || Program.StopRequested || Program.HeartbeatAge > 10) throw new IOException("The parent stopped before a change."); Set(record, record.requestedEnabled, true); }
                                send(new { type = "result", id = id });
                            }
                        } catch (Exception error) { send(new { type = "error", message = error.Message }); }
                        finally { RestoreUntilSuccessful(store, records, error => send(new { type = "recovering", message = error })); }
                    }
                }
            }
        } finally { mutex.ReleaseMutex(); mutex.Dispose(); }
        return 0;
    }
}
