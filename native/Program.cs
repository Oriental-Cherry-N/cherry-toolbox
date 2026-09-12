using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class Json {
    internal static readonly object OutputLock = new object();
    internal static string Encode(object value) { return new JavaScriptSerializer { MaxJsonLength = 1048576, RecursionLimit = 48 }.Serialize(value); }
    internal static Dictionary<string, object> Decode(string line) {
        if (line == null || line.Length > 1048576) throw new InvalidDataException("Missing or oversized structured command.");
        var value = new JavaScriptSerializer { MaxJsonLength = 1048576, RecursionLimit = 48 }.DeserializeObject(line) as Dictionary<string, object>;
        if (value == null) throw new InvalidDataException("A structured object is required.");
        return value;
    }
    internal static string Text(Dictionary<string, object> value, string key) {
        object item; if (!value.TryGetValue(key, out item) || !(item is string)) throw new InvalidDataException("Invalid " + key);
        return (string)item;
    }
    internal static int Integer(Dictionary<string, object> value, string key) {
        object item; if (!value.TryGetValue(key, out item) || !(item is int)) throw new InvalidDataException("Invalid " + key);
        return (int)item;
    }
    internal static bool Boolean(Dictionary<string, object> value, string key) {
        object item; if (!value.TryGetValue(key, out item) || !(item is bool)) throw new InvalidDataException("Invalid " + key);
        return (bool)item;
    }
    internal static void Emit(object value) { lock (OutputLock) { Console.WriteLine(Encode(value)); Console.Out.Flush(); } }
}

internal static class Program {
    internal static volatile bool StopRequested;
    internal static long LastHeartbeat = Stopwatch.GetTimestamp();
    internal static double HeartbeatAge { get { return (Stopwatch.GetTimestamp() - Interlocked.Read(ref LastHeartbeat)) / (double)Stopwatch.Frequency; } }
    internal static void ReadControl(Action<Dictionary<string, object>> command) {
        var thread = new Thread(() => {
            try {
                string line;
                while ((line = Console.ReadLine()) != null) {
                    var value = Json.Decode(line);
                    var type = Json.Text(value, "type");
                    if (type == "heartbeat") Interlocked.Exchange(ref LastHeartbeat, Stopwatch.GetTimestamp());
                    else if (type == "stop") { StopRequested = true; return; }
                    else command(value);
                }
            } catch (Exception error) { Json.Emit(new { type = "error", message = error.Message }); }
            finally { StopRequested = true; }
        });
        thread.IsBackground = true; thread.Start();
    }
    private static int Main(string[] args) {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        try {
            if (args.Length == 1 && args[0] == "--version") { Json.Emit(new { version = 1, jobObjects = true, boundSockets = true, structuredElevation = true }); return 0; }
            if (args.Length == 1 && args[0] == "--adapter-recovery-status") return AdapterBroker.RecoveryStatus();
            if (args.Length >= 1 && args[0] == "adapter") return AdapterBroker.RunElevated(args.Skip(1).ToArray());
            if (args.Length >= 1 && args[0] == "elevate") return AdapterBroker.Elevate(args.Skip(1).ToArray());
            if (args.Length != 1) throw new InvalidDataException("Unsupported helper mode.");
            var configuration = Json.Decode(Console.ReadLine());
            if (args[0] == "job") return ManagedJob.Run(configuration);
            if (args[0] == "proxy") return BoundProxy.Run(configuration);
            if (args[0] == "self-test") return NativeTests.Run(configuration);
            throw new InvalidDataException("Unsupported helper mode.");
        } catch (Exception error) { Json.Emit(new { type = "error", message = error.Message }); return 1; }
    }
}
